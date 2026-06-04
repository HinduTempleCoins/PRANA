/**
 * deployments.js — the deployments.json registry (backlog E7 / N8).
 *
 * One JSON file records every contract we deploy, per chainId:
 *
 * {
 *   "108369": {
 *     "chainName": "PRANA local",
 *     "rpc": "http://127.0.0.1:8545",
 *     "contracts": {
 *       "PoLToken": {
 *         "address": "0x...",
 *         "block": 123,
 *         "txHash": "0x...",
 *         "constructorArgs": ["..."],
 *         "deployedAt": "2026-06-03T00:00:00.000Z"
 *       }
 *     }
 *   }
 * }
 *
 * Used by deploy scripts (record) and by the wallet/front-end + verification
 * tooling (load). Keep it append/update-only — never hand-edit addresses.
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "..", "..", "deployments.json");

/** Load the full registry (empty object if the file doesn't exist yet). */
function loadRegistry(file = DEFAULT_FILE) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Get the registry slice for one chainId (string or number). */
function forChain(chainId, file = DEFAULT_FILE) {
  const reg = loadRegistry(file);
  return reg[String(chainId)] || null;
}

/** Get a single deployed contract's record, or null. */
function getContract(chainId, name, file = DEFAULT_FILE) {
  const c = forChain(chainId, file);
  return (c && c.contracts && c.contracts[name]) || null;
}

/**
 * Record a deployment. Creates the chain entry on first use.
 * @param {object} opts {chainId, chainName?, rpc?, name, address, block?, txHash?, constructorArgs?}
 */
function record(opts, file = DEFAULT_FILE) {
  const { chainId, chainName, rpc, name, address } = opts;
  if (!chainId || !name || !address) throw new Error("record(): chainId, name, address are required");
  const reg = loadRegistry(file);
  const key = String(chainId);
  if (!reg[key]) reg[key] = { chainName: chainName || "", rpc: rpc || "", contracts: {} };
  if (chainName) reg[key].chainName = chainName;
  if (rpc) reg[key].rpc = rpc;
  reg[key].contracts[name] = {
    address,
    block: opts.block ?? null,
    txHash: opts.txHash ?? null,
    constructorArgs: opts.constructorArgs ?? [],
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(reg, null, 2) + "\n");
  return reg[key].contracts[name];
}

module.exports = { DEFAULT_FILE, loadRegistry, forChain, getContract, record };
