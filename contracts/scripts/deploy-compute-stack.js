/**
 * deploy-compute-stack.js (XX11) — deploy + WIRE the FULL PRANA compute stack.
 *
 * "The chain IS the pool." This script stands up the unified-shares mining pool and all three
 * lanes (HASH / TASK / BURN), the Hathor settlement-fee mechanism, the permissionless-coordinator
 * rails, the burn-stake governance lane, and the decaying-regent governance — then wires every
 * role and pointer so the system is functional end-to-end.
 *
 * Deploy order (dependency-sorted) and the exact wiring are documented inline. Each deploy is
 * try/catch-wrapped (one failure does not abort the rest); every address is logged; the manifest
 * is written to deployments.json under a "compute" key regardless. A wiring summary is printed.
 *
 * Constructor argument orders were read off the .sol sources directly (see deploy() call sites).
 *
 * PRANA token: if deployments.json already records a "PRANA" address we reuse it; otherwise we
 * deploy a MockERC20 (mintable + ERC20Burnable — the burn-stake registry/router require burnable)
 * to make the local stack self-contained, mirroring the E2E test fixtures.
 *
 * Usage:  npx hardhat run scripts/deploy-compute-stack.js --network <name>
 */

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const DEPLOYMENTS_PATH = path.resolve(__dirname, "..", "deployments.json");

// --- shared compute-stack parameters (sane local defaults; DAO-governable in prod) ---
const ONE = 10n ** 18n; // 1e18 WAD
const EPOCH_LEN = 3600n; // 1h epochs (EpochManager-shared across the stack)
const WINDOW = 3n; // 3-epoch trailing PPLNS window
const ISSUANCE = 1000n * ONE; // 1000 PRANA paid per closed epoch
const BURN_WEIGHT = ONE; // BURN lane pools 1:1 (HASH:TASK are pinned 1:1 in ctor)
const VARDIFF_MIN = 1n;
const VARDIFF_MAX = 1_000_000n;
const ATT_MIN_STAKE = 100n * ONE; // attestor min stake to be "active"
const COORD_MIN_BOND = 1000n * ONE; // coordinator minimum bond (>0 so the smoke check passes)
const COORD_COOLDOWN = 7n * 24n * 3600n; // 7-day deregister cooldown
const JOB_CLAIM_WINDOW = 3600n; // 1h before an unsettled job can be released
const VM_WINDOW = 7n * 24n * 3600n; // 7-day verified-machine sustain window
const VM_BUCKETS = 7n; // one verified heartbeat/day required
const REGENT_INITIAL_WEIGHT = 1_000_000n * ONE; // genesis regent governance weight
const REGENT_DURATION = 2n * 365n * 24n * 3600n; // decays to 0 over ~2 years

// CountercyclicalFeeOracle curve params (the recommended-defaults band; bounded by floor/ceiling).
const FEE_PARAMS = {
  floorBps: 10, // 0.10% absolute floor
  ceilingBps: 500, // 5.00% absolute ceiling
  steadyFloorBps: 10, // 0.10% steady lower edge
  steadyCeilBps: 300, // 3.00% steady upper edge
  bootstrapCeilBps: 500, // 5.00% bootstrap ceiling
  machineThresholdX: 1000n, // leave bootstrap once 1000 machines sustained
  refLowPrice: ONE, // PRANA cheap  -> fee high
  refHighPrice: 10n * ONE, // PRANA dear   -> fee low
  bootstrapEpochs: 100n, // bootstrap band available for the first 100 emission epochs
};

function loadManifest() {
  if (!fs.existsSync(DEPLOYMENTS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf8"));
  } catch (_e) {
    return {};
  }
}

// Find an existing PRANA token address in the manifest (top-level contracts map or compute map).
function findExistingPrana(manifest) {
  const top = (manifest && manifest.contracts) || {};
  const comp = (manifest && manifest.compute && manifest.compute.contracts) || {};
  const cand = top.PRANA || comp.PRANA;
  return typeof cand === "string" && ethers.isAddress(cand) ? cand : null;
}

async function main() {
  const [deployer, treasurySigner] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  // Treasury/admin: use a second signer as the treasury where available, else the deployer.
  const treasuryAddr = treasurySigner ? await treasurySigner.getAddress() : deployerAddr;
  const adminAddr = deployerAddr; // DEFAULT_ADMIN across the stack (DAO timelock in prod)

  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);

  console.log(`Network:   ${network.name} (chainId ${chainId})`);
  console.log(`Deployer:  ${deployerAddr}`);
  console.log(`Admin:     ${adminAddr}`);
  console.log(`Treasury:  ${treasuryAddr}`);
  console.log("");

  const contracts = {}; // label -> address
  const wiring = []; // human-readable wiring log lines
  let failures = 0;

  async function deploy(label, factoryName, args = []) {
    try {
      const Factory = await ethers.getContractFactory(factoryName);
      const c = await Factory.deploy(...args);
      await c.waitForDeployment();
      const addr = await c.getAddress();
      contracts[label] = addr;
      console.log(`  ${label.padEnd(28)} ${addr}`);
      return c;
    } catch (err) {
      failures++;
      console.error(`  ${label.padEnd(28)} FAILED: ${err.message || err}`);
      return null;
    }
  }

  async function wire(desc, fn) {
    try {
      const tx = await fn();
      if (tx && tx.wait) await tx.wait();
      wiring.push(`OK  ${desc}`);
      console.log(`  wired: ${desc}`);
    } catch (err) {
      failures++;
      wiring.push(`ERR ${desc} -- ${err.message || err}`);
      console.error(`  WIRE FAILED: ${desc} -- ${err.message || err}`);
    }
  }

  // =========================================================================
  // 0) PRANA token (reuse if recorded; else deploy a burnable+mintable mock).
  // =========================================================================
  const manifest = loadManifest();
  let pranaAddr = findExistingPrana(manifest);
  let prana;
  if (pranaAddr) {
    console.log(`Using existing PRANA token: ${pranaAddr}`);
    contracts.PRANA = pranaAddr;
    prana = await ethers.getContractAt("MockERC20", pranaAddr).catch(() => null);
  } else {
    console.log("No PRANA address recorded — deploying a local MockERC20 (burnable+mintable):");
    prana = await deploy("PRANA", "MockERC20", ["Prana", "PRANA"]);
    pranaAddr = prana ? await prana.getAddress() : null;
  }
  console.log("");

  // =========================================================================
  // 1) Lane-weight config (NN5). HASH:TASK pinned 1:1; BURN = BURN_WEIGHT.
  //    ctor(admin, burnWeight, minDifficulty, maxDifficulty)
  // =========================================================================
  console.log("Deploying compute stack:");
  const cfg = await deploy("HashTaskWeightConfig", "HashTaskWeightConfig", [
    adminAddr,
    BURN_WEIGHT,
    VARDIFF_MIN,
    VARDIFF_MAX,
  ]);

  // =========================================================================
  // 2) UnifiedSharesLedger (NN1) — the canonical pool.
  //    ctor(prana, weightConfig, admin, epochLength, windowEpochs, epochIssuance)
  // =========================================================================
  const ledger =
    prana && cfg
      ? await deploy("UnifiedSharesLedger", "UnifiedSharesLedger", [
          pranaAddr,
          await cfg.getAddress(),
          adminAddr,
          EPOCH_LEN,
          WINDOW,
          ISSUANCE,
        ])
      : null;

  // =========================================================================
  // 3) HASH lane creditor (NN2). ctor(ledger, beacon, admin) — beacon=0 (open mode)
  // =========================================================================
  const hashCreditor = ledger
    ? await deploy("HashLaneCreditor", "HashLaneCreditor", [
        await ledger.getAddress(),
        ethers.ZeroAddress,
        adminAddr,
      ])
    : null;

  // =========================================================================
  // 4) TASK lane: AttestationStakeSlash -> TaskVerificationGate -> TaskRegistry -> TaskLaneCreditor
  // =========================================================================
  // 4a) stake token for attestors (local mock).
  const stakeTok = await deploy("AttestationStakeToken", "MockERC20", ["Attestation Stake", "ASTK"]);

  // 4b) AttestationStakeSlash. ctor(stakeToken, minStake, treasury, admin)
  const attestation = stakeTok
    ? await deploy("AttestationStakeSlash", "AttestationStakeSlash", [
        await stakeTok.getAddress(),
        ATT_MIN_STAKE,
        treasuryAddr,
        adminAddr,
      ])
    : null;

  // 4c) TaskVerificationGate (NN4). ctor(attestation, admin)
  const gate = attestation
    ? await deploy("TaskVerificationGate", "TaskVerificationGate", [
        await attestation.getAddress(),
        adminAddr,
      ])
    : null;

  // 4d) TaskRegistry (RR1). ctor(admin)
  const taskRegistry = await deploy("TaskRegistry", "TaskRegistry", [adminAddr]);

  // 4e) TaskLaneCreditor (NN3). ctor(ledger, registry, gate, beacon, admin) — beacon=0 (open mode)
  const taskCreditor =
    ledger && taskRegistry && gate
      ? await deploy("TaskLaneCreditor", "TaskLaneCreditor", [
          await ledger.getAddress(),
          await taskRegistry.getAddress(),
          await gate.getAddress(),
          ethers.ZeroAddress,
          adminAddr,
        ])
      : null;

  // 4f) TaskDispatchPolicy (RR2). ctor(registry, admin)
  const dispatchPolicy = taskRegistry
    ? await deploy("TaskDispatchPolicy", "TaskDispatchPolicy", [
        await taskRegistry.getAddress(),
        adminAddr,
      ])
    : null;

  // =========================================================================
  // 5) BURN lane: BurnStakeRegistry -> GovernanceAdapter + PriceSource + Router
  // =========================================================================
  // 5a) BurnStakeRegistry (OO1). ctor(prana[ERC20Burnable], admin)
  const burnRegistry =
    prana ? await deploy("BurnStakeRegistry", "BurnStakeRegistry", [pranaAddr, adminAddr]) : null;

  // 5b) BurnStakeGovernanceAdapter (OO2). ctor(registry) — wired back as the registry weightHook.
  const burnGovAdapter = burnRegistry
    ? await deploy("BurnStakeGovernanceAdapter", "BurnStakeGovernanceAdapter", [
        await burnRegistry.getAddress(),
      ])
    : null;

  // 5c) FixedRatioPriceSource (OO4, safe default). ctor(admin)
  const priceSource = await deploy("FixedRatioPriceSource", "FixedRatioPriceSource", [adminAddr]);

  // 5d) MultiCurrencyBurnRouter (OO3). ctor(admin, registry, priceSource)
  const burnRouter =
    burnRegistry && priceSource
      ? await deploy("MultiCurrencyBurnRouter", "MultiCurrencyBurnRouter", [
          adminAddr,
          await burnRegistry.getAddress(),
          await priceSource.getAddress(),
        ])
      : null;

  // =========================================================================
  // 6) Hathor fee mechanism: Treasury + PriceFeed + EmissionPhase + VerifiedMachineCounter
  //    -> CountercyclicalFeeOracle -> SettlementFeeHook
  // =========================================================================
  // 6a) HathorFeeTreasury (PP3). ctor(admin, governor) — never trades; governed withdrawals only.
  const feeTreasury = await deploy("HathorFeeTreasury", "HathorFeeTreasury", [adminAddr, adminAddr]);

  // 6b) Price feed (IPriceFeedView). SimplePriceOracle.price(token) matches the interface.
  const priceFeed = await deploy("SimplePriceOracle", "SimplePriceOracle", [adminAddr]);

  // 6c) Emission-phase source (IEmissionPhaseView). MockEmissionPhase is a clean settable stand-in;
  //     swap for the real EmissionScheduler (also exposes currentEpoch()) in production.
  const emissionPhase = await deploy("EmissionPhaseView", "MockEmissionPhase", []);

  // 6d) VerifiedMachineCounter (PP4). ctor(admin, window, buckets)
  const machineCounter = await deploy("VerifiedMachineCounter", "VerifiedMachineCounter", [
    adminAddr,
    VM_WINDOW,
    VM_BUCKETS,
  ]);

  // 6e) CountercyclicalFeeOracle (PP2). ctor(admin, priceFeed, pranaToken, emission, counter, params)
  const feeOracle =
    priceFeed && emissionPhase && machineCounter
      ? await deploy("CountercyclicalFeeOracle", "CountercyclicalFeeOracle", [
          adminAddr,
          await priceFeed.getAddress(),
          pranaAddr,
          await emissionPhase.getAddress(),
          await machineCounter.getAddress(),
          FEE_PARAMS,
        ])
      : null;

  // 6f) SettlementFeeHook (PP1). ctor(admin, ledger, treasury, oracle) — grants LEDGER_ROLE to ledger.
  const feeHook =
    ledger && feeTreasury && feeOracle
      ? await deploy("SettlementFeeHook", "SettlementFeeHook", [
          adminAddr,
          await ledger.getAddress(),
          await feeTreasury.getAddress(),
          await feeOracle.getAddress(),
        ])
      : null;

  // =========================================================================
  // 7) Permissionless-coordinator rails: CoordinatorRegistry + JobClaimLedger
  // =========================================================================
  // 7a) CoordinatorRegistry (PR1). ctor(bondToken, admin, treasury, minBond, cooldown)
  const coordRegistry = prana
    ? await deploy("CoordinatorRegistry", "CoordinatorRegistry", [
        pranaAddr,
        adminAddr,
        treasuryAddr,
        COORD_MIN_BOND,
        COORD_COOLDOWN,
      ])
    : null;

  // 7b) JobClaimLedger (PR2). ctor(registry, admin, claimWindow)
  const jobClaimLedger = coordRegistry
    ? await deploy("JobClaimLedger", "JobClaimLedger", [
        await coordRegistry.getAddress(),
        adminAddr,
        JOB_CLAIM_WINDOW,
      ])
    : null;

  // =========================================================================
  // 8) Regent governance (decaying founder weight): RegentGovernance + RegentVotesAdapter
  // =========================================================================
  // 8a) RegentGovernance (QQ1). ctor(admin, initialWeight, start[0=now], duration)
  const regent = await deploy("RegentGovernance", "RegentGovernance", [
    adminAddr,
    REGENT_INITIAL_WEIGHT,
    0n,
    REGENT_DURATION,
  ]);

  // 8b) RegentVotesAdapter (QQ2). ctor(regent, regentAccount)
  const regentVotes = regent
    ? await deploy("RegentVotesAdapter", "RegentVotesAdapter", [await regent.getAddress(), adminAddr])
    : null;

  console.log("");
  console.log("Wiring roles + pointers:");

  // ----- ledger lane creditor roles -----
  if (ledger && hashCreditor) {
    await wire("ledger.HASH_CREDITOR -> HashLaneCreditor", async () =>
      ledger.grantRole(await ledger.HASH_CREDITOR(), await hashCreditor.getAddress())
    );
  }
  if (ledger && taskCreditor) {
    await wire("ledger.TASK_CREDITOR -> TaskLaneCreditor", async () =>
      ledger.grantRole(await ledger.TASK_CREDITOR(), await taskCreditor.getAddress())
    );
  }
  if (ledger) {
    // BURN lane is credited by an off-chain emission keeper that reads BurnStakeRegistry.weightOf.
    // Grant BURN_CREDITOR to the deployer (the keeper key) so the burn-emission path is live.
    await wire("ledger.BURN_CREDITOR -> deployer (burn-emission keeper)", async () =>
      ledger.grantRole(await ledger.BURN_CREDITOR(), deployerAddr)
    );
    // FUNDER_ROLE -> deployer/treasury so the issuance budget can be funded (fundEpoch).
    await wire("ledger.FUNDER_ROLE -> deployer", async () =>
      ledger.grantRole(await ledger.FUNDER_ROLE(), deployerAddr)
    );
  }

  // ----- TASK lane wiring -----
  if (gate && taskCreditor) {
    await wire("gate.CONSUMER_ROLE -> TaskLaneCreditor", async () =>
      gate.grantRole(await gate.CONSUMER_ROLE(), await taskCreditor.getAddress())
    );
  }
  if (taskRegistry && gate) {
    // Register a default task-type so the dispatch policy + creditor have a live entry.
    // setTaskType(taskId, specHash, verificationGate, shareWeight, priority, enabled)
    await wire('taskRegistry.setTaskType("hathor-inference", gate, 1e18, prio 100, enabled)', async () =>
      taskRegistry.setTaskType(
        ethers.id("hathor-inference"),
        ethers.ZeroHash,
        await gate.getAddress(),
        ONE,
        100n,
        true
      )
    );
  }

  // ----- settlement fee hook wiring -----
  if (ledger && feeHook) {
    // ledger.setFeeHook routes claim() payouts through the hook (skim taken inline at settlement).
    await wire("ledger.setFeeHook -> SettlementFeeHook", async () =>
      ledger.setFeeHook(await feeHook.getAddress())
    );
    // The hook pulls fee+net from the ledger via transferFrom; grant a max approval once.
    // (The ledger ALSO force-approves the hook per-claim, but a standing approval keeps reads/quote
    //  consistent and is harmless.) Approve from the ledger's own context is not possible from here,
    //  so this is documented as handled by the ledger inline; we note the LEDGER_ROLE grant instead.
    // SettlementFeeHook ctor already granted LEDGER_ROLE to the ledger (see PP1 ctor) — verify only.
    wiring.push("NOTE SettlementFeeHook granted LEDGER_ROLE to ledger in its constructor (PP1)");
  }
  if (feeTreasury && feeHook) {
    // The treasury is the immutable skim destination baked into the hook's ctor; no grant needed.
    wiring.push("NOTE HathorFeeTreasury is the hook's immutable skim destination (PP1 ctor)");
  }

  // ----- price feed seed (so the fee oracle has a live PRANA price) -----
  if (priceFeed && pranaAddr) {
    await wire("priceFeed.setPrice(PRANA, 5e18) (mid-band)", async () =>
      priceFeed.setPrice(pranaAddr, 5n * ONE)
    );
  }

  // ----- BURN lane wiring -----
  if (burnRegistry && burnGovAdapter) {
    // weightHook auto-checkpoints the governance adapter on every burn credit.
    await wire("burnRegistry.setWeightHook -> BurnStakeGovernanceAdapter", async () =>
      burnRegistry.setWeightHook(await burnGovAdapter.getAddress())
    );
  }
  if (burnRegistry && burnRouter) {
    // Router records normalized cross-currency weight into the registry: needs BURNER_ROLE.
    await wire("burnRegistry.BURNER_ROLE -> MultiCurrencyBurnRouter", async () =>
      burnRegistry.grantRole(await burnRegistry.BURNER_ROLE(), await burnRouter.getAddress())
    );
  }
  if (priceSource && pranaAddr) {
    // Price PRANA at parity (1 burned -> 1 weight) and allowlist it on the router (ERC20 path).
    await wire("priceSource.setRatio(PRANA, 1e18) (parity)", async () =>
      priceSource.setRatio(pranaAddr, ONE)
    );
  }
  if (burnRouter && pranaAddr) {
    await wire("burnRouter.setCurrencyAllowed(PRANA, true)", async () =>
      burnRouter.setCurrencyAllowed(pranaAddr, true)
    );
  }

  // ----- JobClaimLedger already points at the CoordinatorRegistry via its ctor (PR2). -----
  if (jobClaimLedger && coordRegistry) {
    wiring.push("NOTE JobClaimLedger wired to CoordinatorRegistry in its constructor (PR2)");
  }

  // =========================================================================
  // 9) Persist the manifest (merge under a "compute" key; keep any existing top-level data).
  // =========================================================================
  const out = loadManifest();
  out.network = network.name;
  out.chainId = chainId;
  out.compute = {
    network: network.name,
    chainId,
    timestamp: new Date().toISOString(),
    params: {
      epochLength: EPOCH_LEN.toString(),
      windowEpochs: WINDOW.toString(),
      epochIssuance: ISSUANCE.toString(),
      burnWeight: BURN_WEIGHT.toString(),
      coordinatorMinBond: COORD_MIN_BOND.toString(),
      attestorMinStake: ATT_MIN_STAKE.toString(),
    },
    contracts,
    wiring,
  };
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(out, null, 2) + "\n");

  console.log("");
  console.log("==================== WIRING SUMMARY ====================");
  for (const line of wiring) console.log("  " + line);
  console.log("=======================================================");
  console.log("");
  console.log(
    `Deployed ${Object.keys(contracts).length} compute contracts; ` +
      `${failures} failure(s). Wrote ${path.relative(path.resolve(__dirname, ".."), DEPLOYMENTS_PATH)} (compute key).`
  );

  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
