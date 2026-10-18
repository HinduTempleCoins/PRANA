/**
 * e2e-task-lane.js — GridCoin/TASK-lane increment-1 END-TO-END proof on the live PRANA testnet.
 *
 * Proves the full vertical slice, on-chain, against the running core-geth node (chainId 108369):
 *   1. Deploy the real switching-engine stack (weight config, ledger, attestation, gate, task
 *      registry, TaskLaneCreditor, CoordinatorRegistry).
 *   2. Set TASK lane weight REDUCED below HASH (0.25x) — a not-yet-adversarial-safe TASK share
 *      cannot drain the pool at 1:1. HASH stays 1x.
 *   3. A REAL worker runs the REAL deterministic compute kernel (tools/pool-worker) for a real job.
 *   4. The permissionless-coordinator BOND is ENFORCED: registry wired into TaskLaneCreditor; the
 *      coordinator must post a slashable bond to be allowed to credit (unbonded caller reverts).
 *   5. K=1 trusted-committee attestation routed through the REAL gate: openClaim -> attest ->
 *      creditVerified consumes the verdict, credits weighted shares to the gate-bound worker.
 *   6. The worker CLAIMS its epoch payout on-chain and its PRANA (test-ERC20) balance increases.
 *
 * Payout asset is a test ERC20 (mainnet uses native PRANA); epochLength is shortened so a real
 * epoch closes within the run. Everything else is the production contract code, unmodified.
 *
 * Usage: npx hardhat run scripts/e2e-task-lane.js --network localprana
 */
const { ethers } = require("hardhat");

const ONE = 10n ** 18n;
const MIN_STAKE = 100n * ONE;
const MIN_BOND = 1000n * ONE;
const EPOCH_LEN = 6n;           // seconds — shortened for the proof (mainnet: 3600)
const WINDOW = 1n;              // single-epoch PPLNS window -> cheap claim loop
const EPOCH_ISSUANCE = 1000n * ONE;
const TASK_WEIGHT = ONE / 4n;   // 0.25x — REDUCED below HASH (1x)
const TASK_ID = ethers.id("hathor-inference");
const BASE_SHARES = 400n;       // -> pooled = 400 * 0.25 = 100 (proves reduced weight)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function fundGas(deployer, to, amountEth = "1.0") {
  const tx = await deployer.sendTransaction({ to, value: ethers.parseEther(amountEth) });
  await tx.wait();
}

async function main() {
  const provider = ethers.provider;
  const net = await provider.getNetwork();
  const [deployer] = await ethers.getSigners();
  log(`\n=== PRANA TASK-lane E2E — chainId ${net.chainId}, deployer ${deployer.address} ===`);
  log(`deployer native balance: ${ethers.formatEther(await provider.getBalance(deployer.address))}`);

  // fresh keypairs for the distinct roles, funded for gas from the deployer.
  const worker = ethers.Wallet.createRandom().connect(provider);
  const coord = ethers.Wallet.createRandom().connect(provider);
  const att1 = ethers.Wallet.createRandom().connect(provider);
  const treasury = ethers.Wallet.createRandom().connect(provider);
  for (const w of [worker, coord, att1]) await fundGas(deployer, w.address, "5.0");
  log(`worker   ${worker.address}`);
  log(`coord    ${coord.address}`);
  log(`att1     ${att1.address}`);

  const addr = (c) => c.getAddress();

  // --- deploy the stack (production contracts) ---
  const Mock = await ethers.getContractFactory("MockERC20");
  const prana = await Mock.deploy("PranaTest", "tPRANA"); await prana.waitForDeployment();
  const stakeTok = await Mock.deploy("StakeTest", "tSTK"); await stakeTok.waitForDeployment();

  const Cfg = await ethers.getContractFactory("HashTaskWeightConfig");
  const cfg = await Cfg.deploy(deployer.address, ONE, 1n, 1_000_000n); await cfg.waitForDeployment();

  const Ledger = await ethers.getContractFactory("UnifiedSharesLedger");
  const ledger = await Ledger.deploy(await addr(prana), await addr(cfg), deployer.address, EPOCH_LEN, WINDOW, EPOCH_ISSUANCE);
  await ledger.waitForDeployment();

  const Att = await ethers.getContractFactory("AttestationStakeSlash");
  const attestation = await Att.deploy(await addr(stakeTok), MIN_STAKE, treasury.address, deployer.address);
  await attestation.waitForDeployment();

  const Gate = await ethers.getContractFactory("TaskVerificationGate");
  const gate = await Gate.deploy(await addr(attestation), deployer.address); await gate.waitForDeployment();

  const Reg = await ethers.getContractFactory("TaskRegistry");
  const taskRegistry = await Reg.deploy(deployer.address); await taskRegistry.waitForDeployment();
  await (await taskRegistry.setTaskType(TASK_ID, ethers.ZeroHash, await addr(gate), ONE, 0n, true)).wait();

  const Task = await ethers.getContractFactory("TaskLaneCreditor");
  const taskCreditor = await Task.deploy(await addr(ledger), await addr(taskRegistry), await addr(gate), ethers.ZeroAddress, deployer.address);
  await taskCreditor.waitForDeployment();

  const CoordReg = await ethers.getContractFactory("CoordinatorRegistry");
  const coordRegistry = await CoordReg.deploy(await addr(prana), deployer.address, treasury.address, MIN_BOND, 7n * 24n * 3600n);
  await coordRegistry.waitForDeployment();

  log(`\n-- deployed --`);
  log(`prana(tPRANA)        ${await addr(prana)}`);
  log(`UnifiedSharesLedger  ${await addr(ledger)}`);
  log(`TaskVerificationGate ${await addr(gate)}`);
  log(`TaskRegistry         ${await addr(taskRegistry)}`);
  log(`TaskLaneCreditor     ${await addr(taskCreditor)}`);
  log(`CoordinatorRegistry  ${await addr(coordRegistry)}`);

  // --- REDUCED TASK weight (below HASH) ---
  await (await cfg.setLaneWeight(1 /*TASK*/, TASK_WEIGHT)).wait();
  const hw = await cfg.laneWeight(0), tw = await cfg.laneWeight(1);
  log(`\nlane weights: HASH=${ethers.formatEther(hw)}x  TASK=${ethers.formatEther(tw)}x  (TASK reduced below HASH)`);
  if (!(tw < hw)) throw new Error("TASK weight must be < HASH");

  // --- wiring: roles + PR1 bond enforcement ---
  await (await ledger.grantRole(await ledger.TASK_CREDITOR(), await addr(taskCreditor))).wait();
  await (await ledger.grantRole(await ledger.FUNDER_ROLE(), deployer.address)).wait();
  await (await gate.grantRole(await gate.CONSUMER_ROLE(), await addr(taskCreditor))).wait();
  await (await taskCreditor.grantRole(await taskCreditor.CREDITOR_ROLE(), coord.address)).wait();
  await (await taskCreditor.setCoordinatorRegistry(await addr(coordRegistry))).wait(); // PR1 ENFORCED
  log(`PR1: CoordinatorRegistry wired into TaskLaneCreditor (bond now enforced at credit)`);

  // --- fund issuance budget ---
  await (await prana.mint(deployer.address, 1_000_000n * ONE)).wait();
  await (await prana.approve(await addr(ledger), ethers.MaxUint256)).wait();
  await (await ledger.fundEpoch(EPOCH_ISSUANCE * 10n)).wait();

  // --- stake the K=1 committee attestor ---
  await (await stakeTok.mint(att1.address, MIN_STAKE)).wait();
  await (await stakeTok.connect(att1).approve(await addr(attestation), MIN_STAKE)).wait();
  await (await attestation.connect(att1).stake(MIN_STAKE)).wait();
  log(`attestor staked, isActive=${await attestation.isActive(att1.address)}`);

  // --- REAL worker compute (the real deterministic kernel) ---
  const { runTask } = await import("/root/PRANA/tools/pool-worker/src/task-lane.mjs");
  const job = { claimId: null, taskId: TASK_ID, specHash: ethers.ZeroHash, input: `hathor-inference:${Date.now()}`, baseShares: Number(BASE_SHARES), dim: 48, rounds: 2 };
  const claimId = ethers.id(`${job.input}|${job.specHash}`);
  job.claimId = claimId;
  const result = runTask(job, worker.address);
  log(`\nreal compute done: macs=${result.work.macs} (dim=${result.work.dim},rounds=${result.work.rounds}) resultDigest=${result.resultDigest.slice(0,18)}...`);
  // re-run proves reproducibility (redundant-recompute / K-of-N can agree)
  const result2 = runTask(job, worker.address);
  if (result.resultDigest !== result2.resultDigest) throw new Error("compute not reproducible");
  log(`recompute matches -> redundant-recompute safe`);

  // --- PROVE bond enforcement: coord is not yet bonded -> credit path is gated ---
  // (open+attest first so the ONLY thing that can revert is the bond guard.)
  await (await gate.openClaim(claimId, worker.address, 1, [att1.address])).wait();
  await (await gate.connect(att1).attest(claimId)).wait();
  log(`\ngate: isVerified=${await gate.isVerified(claimId)} (K=1 committee attested)`);
  const activeBefore = await coordRegistry.isActiveCoordinator(coord.address);
  // NotActiveCoordinator is defined in CoordinatorRegistry (not the creditor's ABI), so ethers
  // may not decode the name — treat ANY revert as "blocked" and corroborate with the registry view.
  let reverted = false;
  try { await taskCreditor.connect(coord).creditVerified.staticCall(claimId, TASK_ID, BASE_SHARES); }
  catch (e) { reverted = true; }
  log(`coord isActiveCoordinator (pre-bond)=${activeBefore}; unbonded credit blocked=${reverted}`);
  if (activeBefore) throw new Error("coord should not be active before bonding");
  if (!reverted) throw new Error("bond guard did not block an unbonded coordinator");

  // --- coordinator posts its slashable bond -> becomes active ---
  await (await prana.mint(coord.address, MIN_BOND)).wait();
  await (await prana.connect(coord).approve(await addr(coordRegistry), MIN_BOND)).wait();
  const regTx = await coordRegistry.connect(coord).register(MIN_BOND, "http://prana-coord.testnet");
  const regRcpt = await regTx.wait();
  log(`coordinator bonded (${ethers.formatEther(MIN_BOND)} tPRANA), isActive=${await coordRegistry.isActiveCoordinator(coord.address)}  tx=${regRcpt.hash}`);

  // --- credit the verified TASK completion (real gate consume + reduced weight) ---
  const epochBefore = BigInt((await provider.getBlock("latest")).timestamp) / EPOCH_LEN;
  const creditTx = await taskCreditor.connect(coord).creditVerified(claimId, TASK_ID, BASE_SHARES);
  const creditRcpt = await creditTx.wait();
  const creditEpoch = BigInt((await provider.getBlock(creditRcpt.blockNumber)).timestamp) / EPOCH_LEN;
  const pooled = await ledger.poolShares(creditEpoch, worker.address);
  log(`\ncreditVerified tx=${creditRcpt.hash} block=${creditRcpt.blockNumber} epoch=${creditEpoch}`);
  log(`pooled shares to worker = ${pooled}  (baseShares ${BASE_SHARES} x TASK weight 0.25 = ${BASE_SHARES / 4n})`);
  if (pooled !== BASE_SHARES / 4n) throw new Error(`reduced-weight credit wrong: got ${pooled}`);

  // one-shot consume replay guard: a second credit of the same claim must revert.
  let replayBlocked = false;
  try { await taskCreditor.connect(coord).creditVerified.staticCall(claimId, TASK_ID, BASE_SHARES); }
  catch (e) { replayBlocked = true; }
  log(`replay of consumed claim blocked: ${replayBlocked}`);
  if (!replayBlocked) throw new Error("one-shot consume replay guard failed");

  // --- wait for the epoch to CLOSE (real wall-clock), then the worker CLAIMS ---
  log(`\nwaiting for epoch ${creditEpoch} to close (epochLen=${EPOCH_LEN}s)...`);
  for (let i = 0; i < 40; i++) {
    // mine a block so latest.timestamp reflects wall-clock, then check closure.
    await (await deployer.sendTransaction({ to: deployer.address, value: 0 })).wait();
    const ts = BigInt((await provider.getBlock("latest")).timestamp);
    if (ts >= (creditEpoch + 1n) * EPOCH_LEN) { log(`epoch closed at ts=${ts}`); break; }
    await sleep(2000);
  }

  const balBefore = await prana.balanceOf(worker.address);
  const claimable = await ledger.claimable(worker.address, creditEpoch);
  log(`worker claimable for epoch ${creditEpoch}: ${ethers.formatEther(claimable)} tPRANA`);
  const claimTx = await ledger.connect(worker).claim(creditEpoch);
  const claimRcpt = await claimTx.wait();
  const balAfter = await prana.balanceOf(worker.address);
  const paid = balAfter - balBefore;
  log(`\n*** claim tx=${claimRcpt.hash} block=${claimRcpt.blockNumber} ***`);
  log(`worker PRANA balance: ${ethers.formatEther(balBefore)} -> ${ethers.formatEther(balAfter)}  (PAID ${ethers.formatEther(paid)} tPRANA)`);
  if (paid <= 0n) throw new Error("worker was not paid");

  log(`\n===================== E2E PROOF: PASS =====================`);
  log(JSON.stringify({
    chainId: Number(net.chainId),
    contracts: {
      pranaTestToken: await addr(prana),
      UnifiedSharesLedger: await addr(ledger),
      TaskVerificationGate: await addr(gate),
      TaskRegistry: await addr(taskRegistry),
      TaskLaneCreditor: await addr(taskCreditor),
      CoordinatorRegistry: await addr(coordRegistry),
    },
    actors: { worker: worker.address, coordinator: coord.address, attestor: att1.address },
    laneWeights: { HASH: hw.toString(), TASK: tw.toString() },
    job: { claimId, taskId: TASK_ID, macs: result.work.macs, resultDigest: result.resultDigest },
    txs: {
      coordinatorRegisterBond: regRcpt.hash,
      creditVerified: creditRcpt.hash,
      workerClaim: claimRcpt.hash,
    },
    creditEpoch: creditEpoch.toString(),
    pooledShares: pooled.toString(),
    workerPaid_tPRANA: ethers.formatEther(paid),
  }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
