/**
 * smoke-compute.js (XX13) — read-only verifier for the deployed compute stack.
 *
 * After deploy-compute-stack.js writes deployments.json (compute key), this asserts via ethers
 * view calls that every role is granted to the right address, the fee hook is set, the weight
 * config returns 1:1 HASH:TASK, epochLength matches, CoordinatorRegistry.minBond > 0, and the
 * BURN/governance/fee pointers are correctly wired. Prints a PASS/FAIL checklist. No state mutation.
 *
 * Exit code 0 only if every check passes (gates CI).
 *
 * Usage:  npx hardhat run scripts/smoke-compute.js --network <name>
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const DEPLOYMENTS_PATH = path.resolve(__dirname, "..", "deployments.json");
const ONE = 10n ** 18n;
const EXPECT_EPOCH_LEN = 3600n; // must match deploy-compute-stack.js EPOCH_LEN

// Lane enum: HASH=0, TASK=1, BURN=2
const LANE = { HASH: 0, TASK: 1, BURN: 2 };

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok: !!ok, detail: detail == null ? "" : String(detail) });
}
async function tryCheck(label, fn) {
  try {
    const { ok, detail } = await fn();
    check(label, ok, detail);
  } catch (e) {
    check(label, false, (e && e.shortMessage) || (e && e.message) || String(e));
  }
}

function loadCompute() {
  if (!fs.existsSync(DEPLOYMENTS_PATH)) {
    throw new Error("deployments.json not found — run scripts/deploy-compute-stack.js first.");
  }
  const raw = JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf8"));
  if (!raw.compute || !raw.compute.contracts) {
    throw new Error('deployments.json has no "compute" key — run scripts/deploy-compute-stack.js.');
  }
  return raw.compute.contracts;
}

async function main() {
  const c = loadCompute();
  const at = async (name, addr) => (addr ? ethers.getContractAt(name, addr) : null);

  const ledger = await at("UnifiedSharesLedger", c.UnifiedSharesLedger);
  const cfg = await at("HashTaskWeightConfig", c.HashTaskWeightConfig);
  const hashCreditor = c.HashLaneCreditor;
  const taskCreditor = c.TaskLaneCreditor;
  const gate = await at("TaskVerificationGate", c.TaskVerificationGate);
  const taskRegistry = await at("TaskRegistry", c.TaskRegistry);
  const burnRegistry = await at("BurnStakeRegistry", c.BurnStakeRegistry);
  const burnRouter = c.MultiCurrencyBurnRouter;
  const burnGovAdapter = c.BurnStakeGovernanceAdapter;
  const priceSource = await at("FixedRatioPriceSource", c.FixedRatioPriceSource);
  const feeHook = await at("SettlementFeeHook", c.SettlementFeeHook);
  const feeOracle = await at("CountercyclicalFeeOracle", c.CountercyclicalFeeOracle);
  const feeTreasury = c.HathorFeeTreasury;
  const coordRegistry = await at("CoordinatorRegistry", c.CoordinatorRegistry);
  const jobClaimLedger = await at("JobClaimLedger", c.JobClaimLedger);
  const pranaAddr = c.PRANA;

  console.log(`Smoke-verifying compute stack on chainId ${(await ethers.provider.getNetwork()).chainId}`);
  console.log("");

  // -------- ledger lane creditor roles --------
  if (ledger) {
    await tryCheck("ledger HASH_CREDITOR -> HashLaneCreditor", async () => {
      const role = await ledger.HASH_CREDITOR();
      return { ok: await ledger.hasRole(role, hashCreditor), detail: hashCreditor };
    });
    await tryCheck("ledger TASK_CREDITOR -> TaskLaneCreditor", async () => {
      const role = await ledger.TASK_CREDITOR();
      return { ok: await ledger.hasRole(role, taskCreditor), detail: taskCreditor };
    });
    await tryCheck("ledger BURN_CREDITOR granted (>=1 holder)", async () => {
      // We can't enumerate; verify the role exists and the deployer (admin) holds it.
      const [deployer] = await ethers.getSigners();
      const role = await ledger.BURN_CREDITOR();
      return { ok: await ledger.hasRole(role, await deployer.getAddress()), detail: await deployer.getAddress() };
    });
    await tryCheck("ledger FUNDER_ROLE granted to deployer", async () => {
      const [deployer] = await ethers.getSigners();
      const role = await ledger.FUNDER_ROLE();
      return { ok: await ledger.hasRole(role, await deployer.getAddress()), detail: await deployer.getAddress() };
    });
    await tryCheck("ledger.feeHook == SettlementFeeHook", async () => {
      const set = await ledger.feeHook();
      return { ok: set.toLowerCase() === String(c.SettlementFeeHook).toLowerCase(), detail: set };
    });
    await tryCheck("ledger.epochLength == 3600", async () => {
      const el = await ledger.epochLength();
      return { ok: el === EXPECT_EPOCH_LEN, detail: el.toString() };
    });
    await tryCheck("ledger.epochIssuance > 0", async () => {
      const iss = await ledger.epochIssuance();
      return { ok: iss > 0n, detail: iss.toString() };
    });
    await tryCheck("ledger.prana == PRANA token", async () => {
      const p = await ledger.prana();
      return { ok: p.toLowerCase() === String(pranaAddr).toLowerCase(), detail: p };
    });
  } else check("UnifiedSharesLedger present", false, "missing");

  // -------- weight config: 1:1 HASH:TASK --------
  if (cfg) {
    await tryCheck("weightConfig HASH == TASK == 1e18 (seamless switching)", async () => {
      const h = await cfg.laneWeight(LANE.HASH);
      const t = await cfg.laneWeight(LANE.TASK);
      return { ok: h === ONE && t === ONE, detail: `HASH=${h} TASK=${t}` };
    });
    await tryCheck("weightConfig BURN weight > 0", async () => {
      const b = await cfg.laneWeight(LANE.BURN);
      return { ok: b > 0n, detail: b.toString() };
    });
  } else check("HashTaskWeightConfig present", false, "missing");

  // -------- TASK lane --------
  if (gate) {
    await tryCheck("gate CONSUMER_ROLE -> TaskLaneCreditor", async () => {
      const role = await gate.CONSUMER_ROLE();
      return { ok: await gate.hasRole(role, taskCreditor), detail: taskCreditor };
    });
  }
  if (taskRegistry) {
    await tryCheck('taskRegistry "hathor-inference" enabled, weight 1e18', async () => {
      const id = ethers.id("hathor-inference");
      const enabled = await taskRegistry.isEnabled(id);
      const w = await taskRegistry.shareWeight(id);
      return { ok: enabled && w === ONE, detail: `enabled=${enabled} weight=${w}` };
    });
  }

  // -------- fee mechanism --------
  if (feeHook) {
    await tryCheck("feeHook LEDGER_ROLE -> ledger", async () => {
      const role = await feeHook.LEDGER_ROLE();
      return { ok: await feeHook.hasRole(role, c.UnifiedSharesLedger), detail: c.UnifiedSharesLedger };
    });
    await tryCheck("feeHook.treasury == HathorFeeTreasury", async () => {
      const t = await feeHook.treasury();
      return { ok: t.toLowerCase() === String(feeTreasury).toLowerCase(), detail: t };
    });
  }
  if (feeOracle) {
    await tryCheck("feeOracle.currentRateBps in [floor,ceiling]", async () => {
      const rate = await feeOracle.currentRateBps();
      return { ok: rate >= 10n && rate <= 500n, detail: `${rate} bps` };
    });
  }

  // -------- BURN lane --------
  if (burnRegistry) {
    await tryCheck("burnRegistry.weightHook -> BurnStakeGovernanceAdapter", async () => {
      const h = await burnRegistry.weightHook();
      return { ok: h.toLowerCase() === String(burnGovAdapter).toLowerCase(), detail: h };
    });
    await tryCheck("burnRegistry BURNER_ROLE -> MultiCurrencyBurnRouter", async () => {
      const role = await burnRegistry.BURNER_ROLE();
      return { ok: await burnRegistry.hasRole(role, burnRouter), detail: burnRouter };
    });
  }
  if (priceSource && pranaAddr) {
    await tryCheck("priceSource.ratioWad(PRANA) == 1e18 (parity)", async () => {
      const r = await priceSource.ratioWad(pranaAddr);
      return { ok: r === ONE, detail: r.toString() };
    });
  }

  // -------- coordinator rails --------
  if (coordRegistry) {
    await tryCheck("CoordinatorRegistry.minBond > 0", async () => {
      const mb = await coordRegistry.minBond();
      return { ok: mb > 0n, detail: mb.toString() };
    });
    await tryCheck("CoordinatorRegistry.bondToken == PRANA", async () => {
      const bt = await coordRegistry.bondToken();
      return { ok: bt.toLowerCase() === String(pranaAddr).toLowerCase(), detail: bt };
    });
  }
  if (jobClaimLedger) {
    await tryCheck("JobClaimLedger.registry -> CoordinatorRegistry", async () => {
      const reg = await jobClaimLedger.registry();
      return { ok: reg.toLowerCase() === String(c.CoordinatorRegistry).toLowerCase(), detail: reg };
    });
  }

  // -------- print checklist --------
  const nameW = Math.max(...results.map((r) => r.label.length), 8);
  console.log(`${"CHECK".padEnd(nameW)}  RESULT`);
  console.log("-".repeat(nameW + 10));
  let failures = 0;
  for (const r of results) {
    const mark = r.ok ? "PASS" : "FAIL";
    if (!r.ok) failures++;
    console.log(`${r.label.padEnd(nameW)}  ${mark}${r.detail ? "  (" + r.detail + ")" : ""}`);
  }
  console.log("");
  const passed = results.length - failures;
  console.log(`${passed}/${results.length} checks passed.`);
  if (failures > 0) {
    console.error(`${failures} compute-stack smoke check(s) FAILED.`);
    process.exit(1);
  }
  console.log("All compute-stack smoke checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
