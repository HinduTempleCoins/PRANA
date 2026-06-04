const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// smoke.js — read-only post-deploy sanity check.
//
// Reads contracts/deployments.json (the address book written by a deploy
// script such as deploy-core.js) and, for each entry, calls a handful of
// view functions on-chain to confirm the contract is live, reachable, and
// returns sane values. Nothing here sends a transaction or spends gas — it
// is safe to run against any network at any time.
//
// Usage:
//   npx hardhat run scripts/smoke.js --network prana_local
//
// Exit code is 0 only if every check passes; non-zero if any check throws,
// so it can gate a CI pipeline.
// ---------------------------------------------------------------------------

const DEPLOYMENTS_PATH = path.join(__dirname, "..", "deployments.json");

// Per-contract read-only probes. Keyed by the contract's Solidity name (the
// `name` field a deploy script records, or the JSON key). Each probe is a
// {label, run} pair where `run(c)` calls a view function on the attached
// contract `c` and returns a printable value (or throws on failure).
//
// Unknown contract names fall back to a generic liveness probe (just confirm
// code exists at the address), so this script never hard-fails on a contract
// it doesn't have a specific recipe for — it simply can't go stale silently.
const CHECKS = {
  PoLToken: [
    { label: "name()", run: (c) => c.name() },
    { label: "symbol()", run: (c) => c.symbol() },
    { label: "decimals()", run: async (c) => (await c.decimals()).toString() },
    { label: "totalSupply()", run: async (c) => (await c.totalSupply()).toString() },
  ],
  WrappedNative: [
    { label: "name()", run: (c) => c.name() },
    { label: "symbol()", run: (c) => c.symbol() },
    { label: "decimals()", run: async (c) => (await c.decimals()).toString() },
    { label: "totalSupply()", run: async (c) => (await c.totalSupply()).toString() },
  ],
  VoteEscrow: [
    { label: "maxLock()", run: async (c) => (await c.maxLock()).toString() },
    { label: "totalLocked()", run: async (c) => (await c.totalLocked()).toString() },
  ],
  BurnMine: [
    { label: "ratioNum()", run: async (c) => (await c.ratioNum()).toString() },
    { label: "ratioDen()", run: async (c) => (await c.ratioDen()).toString() },
    { label: "totalBurned()", run: async (c) => (await c.totalBurned()).toString() },
    { label: "totalMinted()", run: async (c) => (await c.totalMinted()).toString() },
  ],
};

// Generic fallback for any contract without a specific recipe above: prove
// there is bytecode deployed at the recorded address.
function genericCheck(provider) {
  return [
    {
      label: "code@address",
      run: async (_c, addr) => {
        const code = await provider.getCode(addr);
        if (!code || code === "0x") throw new Error("no code at address");
        return `${(code.length - 2) / 2} bytes`;
      },
    },
  ];
}

// Pull a usable {name, address} out of whatever shape deployments.json has.
// Accepts either:
//   { "PoLToken": "0x..", ... }                          (name -> address)
//   { "PoLToken": { "address": "0x..", ... }, ... }      (name -> object)
//   { "contracts": { ...one of the above... } }          (wrapped)
function normalizeDeployments(raw) {
  const src = raw && typeof raw === "object" && raw.contracts ? raw.contracts : raw;
  const out = [];
  if (!src || typeof src !== "object") return out;
  for (const [name, val] of Object.entries(src)) {
    let address = null;
    if (typeof val === "string") address = val;
    else if (val && typeof val === "object") address = val.address || val.addr || null;
    if (typeof address === "string" && ethers.isAddress(address)) {
      out.push({ name, address });
    }
  }
  return out;
}

function printTable(rows) {
  const nameW = Math.max(8, ...rows.map((r) => r.name.length));
  const checkW = Math.max(5, ...rows.map((r) => r.check.length));
  const header = `${"CONTRACT".padEnd(nameW)}  ${"CHECK".padEnd(checkW)}  RESULT`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    const mark = r.ok ? "✓" : "✗"; // ✓ / ✗
    console.log(`${r.name.padEnd(nameW)}  ${r.check.padEnd(checkW)}  ${mark} ${r.result}`);
  }
}

async function main() {
  if (!fs.existsSync(DEPLOYMENTS_PATH)) {
    console.error("No deployments.json found at " + DEPLOYMENTS_PATH);
    console.error(
      "Deploy the core contracts first, e.g.:\n" +
        "  PRANA_DEPLOYER_KEY=0x... npx hardhat run scripts/deploy-core.js --network prana_local\n" +
        "That script should write deployments.json (a name -> address map), which this " +
        "smoke test reads."
    );
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf8"));
  } catch (e) {
    console.error("deployments.json is not valid JSON: " + e.message);
    process.exit(1);
  }

  const deployed = normalizeDeployments(raw);
  if (deployed.length === 0) {
    console.error("deployments.json contained no usable {name: address} entries.");
    process.exit(1);
  }

  const provider = ethers.provider;
  const net = await provider.getNetwork();
  console.log(`Smoke-testing ${deployed.length} contract(s) on chainId ${net.chainId}\n`);

  const rows = [];
  let failures = 0;

  for (const { name, address } of deployed) {
    const probes = CHECKS[name] || genericCheck(provider);

    // Attach via the compiled artifact ABI when we have one; otherwise fall
    // back to a bare provider-level liveness check (generic probes don't need
    // a contract instance).
    let contract = null;
    try {
      contract = await ethers.getContractAt(name, address);
    } catch (_e) {
      // No artifact for this name — fine for the generic code-only probe.
    }

    for (const probe of probes) {
      try {
        const value = await probe.run(contract, address);
        rows.push({ name, check: probe.label, ok: true, result: String(value) });
      } catch (e) {
        failures++;
        const msg = (e && e.shortMessage) || (e && e.message) || String(e);
        rows.push({ name, check: probe.label, ok: false, result: msg });
      }
    }
  }

  console.log("");
  printTable(rows);
  console.log("");

  const total = rows.length;
  const passed = total - failures;
  console.log(`${passed}/${total} checks passed across ${deployed.length} contract(s).`);

  if (failures > 0) {
    console.error(`${failures} check(s) FAILED.`);
    process.exit(1);
  }
  console.log("All smoke checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
