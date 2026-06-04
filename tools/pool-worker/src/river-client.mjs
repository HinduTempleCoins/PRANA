// @prana/pool-worker — river client stub (TASK XX20)
//
// The "river" / minnow-swarm model (design/compute/river-join.md §5): many small
// nodes each hold ONE SHARD of a model too big for any single box, and together
// they serve inference — the Petals / Hivemind pattern. A worker JOINS the river
// by registering a shard with a coordinator, then HEARTBEATS so the swarm knows
// it is alive; Hathor/Qwen pulls inference from whichever shards are currently up.
//
// ⚠️ THIS IS A STUB. No real Petals/Hivemind/libp2p networking happens. Each
//    method documents the REAL Petals API shape it would wrap (see the Petals
//    `petals.cli.run_server` / `AutoDistributedModelForCausalLM` client and the
//    Hivemind DHT it is built on). Timers are unref()'d so a stub heartbeat never
//    keeps the Node process (or the test runner) alive.

import { EventEmitter } from 'node:events';

/**
 * Join the river: register THIS worker as the host of one model shard.
 *
 * REAL SHAPE (Petals): a server process runs e.g.
 *   `python -m petals.cli.run_server <model> --block_indices <start:end>`
 * which announces the blocks (shard) it serves into the Hivemind DHT keyed by
 * the model id; clients then route a forward pass through the live block-holders.
 * This stub just builds and returns an in-memory handle — no DHT, no announce.
 *
 * @param {string} coordinatorUrl   the river coordinator / DHT bootstrap addr.
 * @param {string|number} shardId    which shard/block-range this node serves.
 * @param {object} [opts]
 * @param {number} [opts.heartbeatMs=15000]  heartbeat cadence.
 * @returns {RiverClient}
 */
export function joinRiver(coordinatorUrl, shardId, opts = {}) {
  if (!coordinatorUrl) throw new Error('joinRiver: coordinatorUrl required');
  if (shardId === undefined || shardId === null) throw new Error('joinRiver: shardId required');
  const client = new RiverClient(coordinatorUrl, shardId, opts);
  // STUB: real impl would `await dht.store(modelKey, {peerId, blocks})` here.
  client._registered = true;
  client.emit('joined', { coordinatorUrl, shardId: String(shardId) });
  return client;
}

export class RiverClient extends EventEmitter {
  constructor(coordinatorUrl, shardId, opts = {}) {
    super();
    this.coordinatorUrl = coordinatorUrl;
    this.shardId = String(shardId);
    this.heartbeatMs = opts.heartbeatMs ?? 15_000;
    this._registered = false;
    this._timer = null;
    this.beats = 0;
  }

  /** True once joinRiver() has registered this node with the coordinator. */
  get registered() {
    return this._registered;
  }

  /**
   * Start sending periodic heartbeats so the swarm keeps routing to this shard.
   *
   * REAL SHAPE (Hivemind): the DHT entry has a TTL; the server periodically
   * re-announces (`dht.store(..., expiration_time=...)`). If a node DROPS, its
   * entry expires and clients route around it — graceful degradation (the honest
   * crux noted in river-join.md: a dropped shard-holder reroutes, but tail
   * latency spikes and an in-flight pass may have to retry).
   *
   * STUB: just bumps a counter on an interval. The timer is UNREF'd so it never
   * keeps the process / test runner alive on its own.
   *
   * @returns {NodeJS.Timeout} the (unref'd) interval handle.
   */
  heartbeat() {
    if (!this._registered) throw new Error('heartbeat: join the river first');
    if (this._timer) return this._timer; // idempotent
    this._timer = setInterval(() => {
      this.beats += 1;
      // STUB: real impl re-announces the shard TTL into the DHT here.
      this.emit('heartbeat', { shardId: this.shardId, beat: this.beats });
    }, this.heartbeatMs);
    // CRITICAL: do not let a stub heartbeat pin the event loop.
    if (typeof this._timer.unref === 'function') this._timer.unref();
    return this._timer;
  }

  /**
   * Serve one inference step through this node's shard.
   *
   * REAL SHAPE (Petals): the node receives hidden states for its block range,
   * runs the forward pass on those transformer blocks, and forwards the result
   * to the next block-holder in the chain (or back to the client if it owns the
   * tail). Verification still applies — the same off-chain attestation /
   * redundancy the rest of the compute layer uses (river-join.md crux #3).
   *
   * STUB: returns a deterministic synthetic activation so callers/tests are
   * reproducible. No tensors, no model.
   *
   * @param {object} input  e.g. { hiddenState, prompt } — opaque here.
   * @returns {Promise<{ shardId:string, served:boolean, output:string }>}
   */
  async serveShard(input = {}) {
    if (!this._registered) throw new Error('serveShard: join the river first');
    const tag = input.prompt ?? input.hiddenState ?? 'activation';
    return {
      shardId: this.shardId,
      served: true,
      output: `[shard:${this.shardId}] forward(${String(tag)})`,
    };
  }

  /** Leave the river: stop heartbeating + (in real impl) drop the DHT entry. */
  leave() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._registered = false;
    // STUB: real impl would remove its announce / let the TTL lapse.
    this.emit('left', { shardId: this.shardId });
  }
}
