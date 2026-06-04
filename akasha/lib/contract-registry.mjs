/**
 * contract-registry.mjs — Z1
 *
 * A typed contract-registry loader for the Akasha wallet/front-end.
 *
 * It marries two on-disk sources:
 *   1. ABIs    — `contracts/abis/<Name>.json` (one file per contract). Each file
 *                is EITHER a raw ABI array `[ {...fragment}, ... ]` OR a wrapper
 *                object `{ "abi": [ ... ] }` (Hardhat artifact style). We autodetect.
 *   2. Deployments — `contracts/deployments.json`, the registry written by
 *                `contracts/scripts/lib/deployments.js`. Shape (per chainId):
 *                  { "<chainId>": { chainName, rpc, contracts: { Name: { address, ... } } } }
 *
 * loadRegistry({ abisDir, deploymentsFile, chainId }) returns a registry whose
 * entries are keyed by contract name. A contract may have an ABI but no on-chain
 * deployment for the given chainId — in that case `address` is null and
 * `connect()` throws a clear error (you can still read the ABI / Interface).
 *
 * @typedef {import('ethers').InterfaceAbi} InterfaceAbi
 *
 * @typedef {Object} RegistryEntry
 * @property {string} name
 * @property {string|null} address           Checksummed deployed address, or null.
 * @property {InterfaceAbi} abi              The raw ABI fragment array.
 * @property {import('ethers').Interface} iface  Parsed ethers Interface.
 * @property {Object|null} deployment        Full deployments.json record, or null.
 * @property {(providerOrSigner: any) => import('ethers').Contract} connect
 *
 * @typedef {Object} ContractRegistry
 * @property {(name: string) => RegistryEntry} get
 * @property {() => string[]} list
 * @property {(name: string) => boolean} has
 * @property {string} chainId
 */

import fs from 'node:fs';
import path from 'node:path';
import { Interface, Contract, getAddress } from 'ethers';

/**
 * Normalize whatever an ABI json file holds into a raw fragment array.
 * Accepts a raw array, or a `{ abi: [...] }` wrapper (Hardhat artifact).
 * @param {unknown} parsed
 * @param {string} label  For error messages.
 * @returns {any[]}
 */
export function extractAbi(parsed, label = 'ABI') {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.abi)) {
    return parsed.abi;
  }
  throw new Error(
    `${label}: unrecognized ABI shape (expected an array or { abi: [...] })`,
  );
}

/**
 * Load every `*.json` ABI file out of a directory into a Map<name, abiArray>.
 * The contract name is the file basename without `.json`.
 * @param {string} abisDir
 * @returns {Map<string, any[]>}
 */
function loadAbis(abisDir) {
  const out = new Map();
  let files;
  try {
    files = fs.readdirSync(abisDir);
  } catch (err) {
    throw new Error(`contract-registry: cannot read abisDir "${abisDir}": ${err.message}`);
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const name = file.slice(0, -'.json'.length);
    const full = path.join(abisDir, file);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
      throw new Error(`contract-registry: bad JSON in ${full}: ${err.message}`);
    }
    out.set(name, extractAbi(parsed, name));
  }
  return out;
}

/**
 * Read the deployments.json registry slice for one chainId.
 * Tolerant of a missing file (returns {} contracts).
 * @param {string|undefined} deploymentsFile
 * @param {string|number} chainId
 * @returns {{ contracts: Record<string, any>, meta: object|null }}
 */
function loadDeploymentsSlice(deploymentsFile, chainId) {
  if (!deploymentsFile || !fs.existsSync(deploymentsFile)) {
    return { contracts: {}, meta: null };
  }
  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(deploymentsFile, 'utf8'));
  } catch (err) {
    throw new Error(`contract-registry: bad deployments JSON ${deploymentsFile}: ${err.message}`);
  }
  const slice = reg[String(chainId)];
  if (!slice) return { contracts: {}, meta: null };
  return {
    contracts: slice.contracts || {},
    meta: { chainName: slice.chainName, rpc: slice.rpc },
  };
}

/**
 * Build a typed contract registry.
 *
 * @param {Object} opts
 * @param {string} opts.abisDir          Directory of `<Name>.json` ABI files.
 * @param {string} [opts.deploymentsFile] Path to deployments.json (optional).
 * @param {string|number} opts.chainId   Chain id to resolve deployed addresses for.
 * @returns {ContractRegistry}
 */
export function loadRegistry({ abisDir, deploymentsFile, chainId }) {
  if (!abisDir) throw new Error('loadRegistry: abisDir is required');
  if (chainId === undefined || chainId === null) {
    throw new Error('loadRegistry: chainId is required');
  }

  const abis = loadAbis(abisDir);
  const { contracts: deployed, meta } = loadDeploymentsSlice(deploymentsFile, chainId);

  /** @type {Map<string, RegistryEntry>} */
  const entries = new Map();

  for (const [name, abi] of abis) {
    const dep = deployed[name] || null;
    let address = null;
    if (dep && dep.address) {
      try {
        address = getAddress(dep.address);
      } catch {
        address = dep.address; // keep raw if it somehow fails checksum
      }
    }

    const iface = new Interface(abi);

    const connect = (providerOrSigner) => {
      if (!address) {
        throw new Error(
          `contract-registry: "${name}" has no deployment on chainId ${chainId}; ` +
            `cannot connect() (deploy it first, or it is an interface-only ABI).`,
        );
      }
      if (!providerOrSigner) {
        throw new Error(`contract-registry: connect("${name}") requires a provider or signer`);
      }
      return new Contract(address, abi, providerOrSigner);
    };

    entries.set(name, Object.freeze({ name, address, abi, iface, deployment: dep, connect }));
  }

  return {
    chainId: String(chainId),
    meta,
    has: (name) => entries.has(name),
    list: () => [...entries.keys()].sort(),
    get: (name) => {
      const e = entries.get(name);
      if (!e) throw new Error(`contract-registry: no contract named "${name}" (have ABI for ${entries.size})`);
      return e;
    },
  };
}

export default { loadRegistry, extractAbi };
