#!/usr/bin/env node
/**
 * deploy-wizard.mjs — Z5
 *
 * CLI front-end for the token deploy-wizard. Given { name, symbol, cap,
 * initialMint, mintTo } it calls `createToken(...)` on a deployed
 * **ERC20FactoryWizard** (the default) or, with `--clones`, on an
 * **ERC20CloneFactory** — both share the same createToken signature
 * `(string name, string symbol, uint256 cap, uint256 initialMint, address mintTo)`.
 *
 * Flow:
 *   1. parse args (flags OR interactive readline prompts for any missing field)
 *   2. resolve the factory address from contracts/deployments.json (via the
 *      deployments lib, loaded with createRequire since it's CommonJS)
 *   3. send createToken() from a signer (key read from --key <path> | $AKASHA_KEY)
 *   4. read the new token address out of the TokenCreated/CloneCreated event
 *   5. record the deployment via the deployments lib (record)
 *   6. build an explorer verification payload (lib/verification-helper.mjs) and
 *      print the Blockscout standard-JSON request
 *
 * `--dry-run` stops at step 3: it prints the would-be tx (to/data/from) and the
 * counterfactual nothing-sent summary, never broadcasting.
 *
 * The PURE, chain-free parts — `parseArgs`, `buildCreateTokenTx`,
 * `buildWizardVerification` — are exported for unit testing.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { Interface, JsonRpcProvider, Wallet, getAddress, isAddress } from 'ethers';
import { buildVerificationPayload, loadBuildInfo } from '../lib/verification-helper.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Repo layout: akasha/tools/ -> ../../contracts
const CONTRACTS_DIR = path.resolve(__dirname, '..', '..', 'contracts');
const DEPLOYMENTS_LIB = path.join(CONTRACTS_DIR, 'scripts', 'lib', 'deployments.js');

const DEFAULT_CHAIN_ID = 108369;
const DEFAULT_RPC = 'http://127.0.0.1:8545';

// createToken is identical on both factories.
const CREATE_TOKEN_IFACE = new Interface([
  'function createToken(string name, string symbol, uint256 cap, uint256 initialMint, address mintTo) returns (address)',
  'event TokenCreated(address indexed token, address indexed creator, string name, string symbol, uint256 cap)',
  'event CloneCreated(address indexed token, address indexed creator, string name, string symbol, uint256 cap, bytes32 salt)',
]);

// --- arg parsing (PURE) -----------------------------------------------------

/**
 * Parse argv (after `node deploy-wizard.mjs`) into a normalized options object.
 * Numeric token amounts stay STRINGS here (decimal or 0x) — the caller coerces
 * to wei/BigInt at tx-build time, so the parser never loses precision.
 *
 * @param {string[]} argv
 * @returns {{name?,symbol?,cap?,initialMint?,mintTo?,clones,dryRun,key?,rpc,chainId,factory?,buildInfo?,verifyName?}}
 */
export function parseArgs(argv) {
  const out = {
    clones: false,
    dryRun: false,
    rpc: DEFAULT_RPC,
    chainId: DEFAULT_CHAIN_ID,
  };
  const flagAliases = {
    '--clones': 'clones',
    '--dry-run': 'dryRun',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--clones' || a === '--dry-run') {
      out[flagAliases[a]] = true;
      continue;
    }
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const eq = a.indexOf('=');
    let key, val;
    if (eq !== -1) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      val = argv[++i];
      if (val === undefined) throw new Error(`flag --${key} expects a value`);
    }
    switch (key) {
      case 'name': out.name = val; break;
      case 'symbol': out.symbol = val; break;
      case 'cap': out.cap = val; break;
      case 'initialMint': case 'initial-mint': out.initialMint = val; break;
      case 'mintTo': case 'mint-to': out.mintTo = val; break;
      case 'key': out.key = val; break;
      case 'rpc': out.rpc = val; break;
      case 'chainId': case 'chain-id': out.chainId = Number(val); break;
      case 'factory': out.factory = val; break;
      case 'buildInfo': case 'build-info': out.buildInfo = val; break;
      case 'verifyName': case 'verify-name': out.verifyName = val; break;
      default: throw new Error(`unknown flag --${key}`);
    }
  }
  if (out.chainId != null && !Number.isInteger(out.chainId)) {
    throw new Error('--chainId must be an integer');
  }
  return out;
}

/** Names of the required token fields, for interactive prompting. */
const REQUIRED_FIELDS = ['name', 'symbol', 'cap', 'initialMint', 'mintTo'];

// --- tx building (PURE) -----------------------------------------------------

function toWei(v) {
  // amounts are given as exact base-unit integers (decimal or 0x). No decimals
  // magic here — the token's own decimals are the caller's concern.
  if (v == null || v === '') return 0n;
  return BigInt(v);
}

/**
 * Build the unsigned createToken() call (to + data) for a factory address.
 * Pure: validates inputs and ABI-encodes; does not touch a chain.
 *
 * @param {object} opts {factoryAddress, name, symbol, cap, initialMint, mintTo}
 * @returns {{to:string, data:string, args:{name,symbol,cap:bigint,initialMint:bigint,mintTo:string}}}
 */
export function buildCreateTokenTx(opts) {
  const { factoryAddress, name, symbol } = opts;
  if (!factoryAddress || !isAddress(factoryAddress)) {
    throw new Error(`buildCreateTokenTx: invalid factory address ${factoryAddress}`);
  }
  if (typeof name !== 'string' || name.length === 0) throw new Error('name is required');
  if (typeof symbol !== 'string' || symbol.length === 0) throw new Error('symbol is required');

  const cap = toWei(opts.cap);
  const initialMint = toWei(opts.initialMint);
  // mintTo only matters when minting; default zero address when not.
  let mintTo = opts.mintTo;
  if (initialMint > 0n) {
    if (!mintTo || !isAddress(mintTo)) throw new Error(`mintTo is required (and must be an address) when initialMint > 0`);
    mintTo = getAddress(mintTo);
  } else {
    mintTo = mintTo && isAddress(mintTo) ? getAddress(mintTo) : '0x0000000000000000000000000000000000000000';
  }
  if (cap !== 0n && initialMint > cap) {
    throw new Error(`initialMint (${initialMint}) exceeds cap (${cap})`);
  }

  const args = { name, symbol, cap, initialMint, mintTo };
  const data = CREATE_TOKEN_IFACE.encodeFunctionData('createToken', [name, symbol, cap, initialMint, mintTo]);
  return { to: getAddress(factoryAddress), data, args };
}

/**
 * Pull the new token address out of a tx receipt's logs by decoding
 * TokenCreated / CloneCreated.
 * @param {{logs:Array<{topics:string[],data:string}>}} receipt
 * @returns {string|null} checksummed token address
 */
export function tokenAddressFromReceipt(receipt) {
  for (const log of receipt.logs || []) {
    try {
      const parsed = CREATE_TOKEN_IFACE.parseLog(log);
      if (parsed && (parsed.name === 'TokenCreated' || parsed.name === 'CloneCreated')) {
        return getAddress(parsed.args.token);
      }
    } catch {
      // not one of our events — skip
    }
  }
  return null;
}

// --- verification payload (PURE wrapper) ------------------------------------

/**
 * Build the explorer verification payload for the *token contract* a wizard
 * deploy produces (ERC20Base for the wizard, ERC20Initializable for clones).
 *
 * @param {object} opts
 * @param {string} opts.address           deployed token address
 * @param {object} opts.buildInfo         parsed Hardhat build-info (from loadBuildInfo)
 * @param {string} opts.contractName      "ERC20Base" | "ERC20Initializable"
 * @param {any[]}  opts.constructorArgs   ctor/initialize args used at deploy
 * @returns {object} blockscout standard-JSON verification request
 */
export function buildWizardVerification({ address, buildInfo, contractName, constructorArgs }) {
  const payload = buildVerificationPayload({
    contractName,
    address,
    constructorArgs,
    buildInfo,
  });
  // Blockscout's standard-JSON endpoint shape.
  return {
    addressHash: payload.address,
    compilerVersion: payload.compilerVersion,
    contractName: payload.contractPath,
    constructorArguments: payload.constructorArgsHex,
    standardJsonInput: payload.standardJsonInput,
  };
}

/** The token contract a given factory mode produces + its ctor args. */
export function tokenContractFor({ clones, args, creator }) {
  if (clones) {
    // clones: initialize(name, symbol, cap, admin) — admin is the factory at init,
    // but verification matches the implementation's source; args mirror the emit.
    return {
      contractName: 'ERC20Initializable',
      constructorArgs: [args.name, args.symbol, args.cap, creator],
    };
  }
  return {
    contractName: 'ERC20Base',
    // ERC20Base(name, symbol, cap, admin) — admin handed to the creator post-deploy.
    constructorArgs: [args.name, args.symbol, args.cap, creator],
  };
}

// --- deployments lib (CommonJS via createRequire) ---------------------------

function loadDeploymentsLib() {
  return require(DEPLOYMENTS_LIB);
}

function resolveFactoryAddress(opts, deploymentsLib) {
  if (opts.factory) {
    if (!isAddress(opts.factory)) throw new Error(`--factory is not a valid address: ${opts.factory}`);
    return getAddress(opts.factory);
  }
  const name = opts.clones ? 'ERC20CloneFactory' : 'ERC20FactoryWizard';
  const rec = deploymentsLib.getContract(opts.chainId, name);
  if (!rec || !rec.address) {
    throw new Error(
      `no ${name} deployment recorded for chainId ${opts.chainId} in deployments.json; ` +
        `deploy it first or pass --factory <address>`,
    );
  }
  return getAddress(rec.address);
}

// --- interactive prompt -----------------------------------------------------

async function promptMissing(opts) {
  const missing = REQUIRED_FIELDS.filter((f) => opts[f] == null || opts[f] === '');
  if (missing.length === 0) return opts;
  const rl = readline.createInterface({ input, output });
  try {
    for (const f of missing) {
      const hint =
        f === 'cap' ? ' (0 = uncapped, base units)' :
        f === 'initialMint' ? ' (base units, 0 = none)' :
        f === 'mintTo' ? ' (address; blank if no initial mint)' : '';
      // eslint-disable-next-line no-await-in-loop
      const answer = (await rl.question(`${f}${hint}: `)).trim();
      opts[f] = answer;
    }
  } finally {
    rl.close();
  }
  return opts;
}

function readKey(opts) {
  let raw = null;
  if (opts.key) {
    raw = fs.readFileSync(opts.key, 'utf8').trim();
  } else if (process.env.AKASHA_KEY) {
    raw = process.env.AKASHA_KEY.trim();
  }
  if (!raw) throw new Error('no signing key: pass --key <path> or set $AKASHA_KEY');
  return raw.startsWith('0x') ? raw : `0x${raw}`;
}

// --- main -------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  await promptMissing(opts);

  const deploymentsLib = loadDeploymentsLib();
  const factoryAddress = resolveFactoryAddress(opts, deploymentsLib);
  const { to, data, args } = buildCreateTokenTx({ ...opts, factoryAddress });

  if (opts.dryRun) {
    const out = {
      dryRun: true,
      mode: opts.clones ? 'clones' : 'wizard',
      factory: factoryAddress,
      tx: { to, data, value: '0x0' },
      args: { ...args, cap: args.cap.toString(), initialMint: args.initialMint.toString() },
    };
    output.write(JSON.stringify(out, null, 2) + '\n');
    return out;
  }

  // --- live path: send the tx ---
  const key = readKey(opts);
  const provider = new JsonRpcProvider(opts.rpc, opts.chainId);
  const signer = new Wallet(key, provider);

  const txResp = await signer.sendTransaction({ to, data });
  const receipt = await txResp.wait();
  const tokenAddress = tokenAddressFromReceipt(receipt);
  if (!tokenAddress) throw new Error('createToken succeeded but no TokenCreated/CloneCreated event was found');

  const tokenName = args.name;
  const { contractName, constructorArgs } = tokenContractFor({
    clones: opts.clones,
    args,
    creator: signer.address,
  });

  // record the deployment in deployments.json
  deploymentsLib.record({
    chainId: opts.chainId,
    rpc: opts.rpc,
    name: args.symbol || tokenName,
    address: tokenAddress,
    block: receipt.blockNumber,
    txHash: receipt.hash,
    constructorArgs: constructorArgs.map((a) => (typeof a === 'bigint' ? a.toString() : a)),
  });

  // build + print the verification payload, if a build-info was supplied
  let verification = null;
  if (opts.buildInfo) {
    const buildInfo = loadBuildInfo(opts.buildInfo);
    verification = buildWizardVerification({
      address: tokenAddress,
      buildInfo,
      contractName: opts.verifyName || contractName,
      constructorArgs,
    });
  }

  const result = {
    token: tokenAddress,
    txHash: receipt.hash,
    block: receipt.blockNumber,
    mode: opts.clones ? 'clones' : 'wizard',
    verification,
  };
  output.write(JSON.stringify(result, null, 2) + '\n');
  return result;
}

// Run when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`deploy-wizard: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  });
}

export default { parseArgs, buildCreateTokenTx, tokenAddressFromReceipt, buildWizardVerification, tokenContractFor, main };
