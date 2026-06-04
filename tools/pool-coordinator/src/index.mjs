// index.mjs — wire the coordinator: load config → start HTTP server → on each epoch tick,
// build batches for closed epochs and settle them on-chain.
//
// Spec: coordinator.md §0-§3. This is the runnable entrypoint (`npm start`). It is the ONLY
// file that does real I/O (listen + timers + would-broadcast). Everything it calls is a tested
// pure module. All timers are .unref()'d so the process can still exit cleanly.
//
// REAL vs STUB: the control loop is real; the on-chain SEND is stubbed in settle.mjs (no ethers
// in the skeleton). Run it and it will accept worker shares, batch them at epoch close, and log
// the settle-tx descriptors it WOULD broadcast.

import { loadConfig } from './config.mjs';
import * as validator from './share-validator.mjs';
import { JobRegistry } from './job-registry.mjs';
import { EpochBatcher } from './epoch-batcher.mjs';
import { buildSettleTx, sendSettleTx, buildJobSettleTx } from './settle.mjs';
import { createServer } from './server.mjs';

export function startCoordinator(env = process.env, { listen = true } = {}) {
  const config = loadConfig(env);
  const log = (line) => console.log(`${new Date().toISOString()} ${line}`);

  const jobRegistry = new JobRegistry({ redundancy: 1, claimWindowMs: 5 * 60_000 });
  const batcher = new EpochBatcher({
    epochLengthSeconds: config.epochLengthSeconds,
    coordinatorId: config.coordinatorId,
  });

  const { server, state } = createServer({ config, validator, jobRegistry, batcher, log });

  // --- epoch tick: settle closed epochs ---
  async function tick() {
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const epoch of batcher.closedPendingEpochs(nowSeconds)) {
      const batch = batcher.buildEpochBatch(epoch, { maxWorkersPerBatch: 200 });
      const txs = buildSettleTx(batch, config);
      if (txs.length === 0) {
        batcher.drainEpoch(epoch);
        continue;
      }
      // STUB broadcast (settle.mjs logs unless a live signer is injected).
      const receipts = await sendSettleTx(txs, { log });
      // finalize cross-coordinator dedup for each settled TASK job.
      for (const tc of batch.taskCredits) {
        await sendSettleTx([buildJobSettleTx(tc.claimId, config)], { log });
      }
      log(
        `[epoch ${epoch}] settled ${batch.hashBatches.length} hash-batch(es) + ` +
          `${batch.taskCredits.length} task-credit(s); ${receipts.length} tx(s)`,
      );
      batcher.drainEpoch(epoch);
    }
  }

  let timer = null;
  if (listen) {
    server.listen(config.port, config.host, () => {
      log(
        `[coordinator] ${config.coordinatorId} for ${config.coin.symbol} (chainId ${config.coin.chainId}) ` +
          `listening on http://${config.host}:${config.port} — epoch=${config.epochLengthSeconds}s`,
      );
      if (config.ledgerAddr === '0x0000000000000000000000000000000000000000') {
        log('[coordinator] NOTE: ledger/creditor addresses unset — settle runs in DRY mode (stub).');
      }
    });
    timer = setInterval(() => {
      tick().catch((e) => log(`[tick] error: ${e?.message || e}`));
    }, config.epochTickMs);
    timer.unref(); // let the process exit despite the interval
  }

  return { config, server, state, jobRegistry, batcher, tick, stop };

  function stop() {
    if (timer) clearInterval(timer);
    return new Promise((resolve) => server.close(resolve));
  }
}

// run when invoked directly (`node src/index.mjs` / `npm start`).
if (import.meta.url === `file://${process.argv[1]}`) {
  startCoordinator();
}
