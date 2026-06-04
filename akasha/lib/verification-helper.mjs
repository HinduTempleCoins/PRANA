/**
 * verification-helper.mjs — Z6
 *
 * Build an explorer (Etherscan / Blockscout standard-JSON) source-verification
 * request from a Hardhat build-info file.
 *
 * A Hardhat build-info JSON looks like:
 *   {
 *     "_format": "hh-sol-build-info-1",
 *     "solcVersion":     "0.8.24",
 *     "solcLongVersion": "0.8.24+commit.e11b9ed9",
 *     "input":  { "language": "Solidity", "sources": {...}, "settings": {...} },  // <- standard JSON input
 *     "output": { "contracts": { "<path>": { "<Name>": { abi, evm, ... } } } }
 *   }
 *
 * The `input` block IS exactly the Solidity standard-JSON input the verifier
 * wants. We pass it through verbatim, pair it with the long compiler version
 * (the form `v0.8.24+commit.e11b9ed9` explorers expect), locate the
 * "<path>:<Name>" fully-qualified contract id, and ABI-encode the constructor
 * args against the contract's own ABI (taken from build output, or an ABI you
 * supply) — explorers want constructor args as a hex string WITHOUT the 0x.
 *
 * The core `buildVerificationPayload(...)` is a pure function (no fs) so it is
 * unit-testable. `loadBuildInfo(path)` is the thin fs helper.
 *
 * @typedef {Object} BuildInfo
 * @property {string} solcVersion
 * @property {string} solcLongVersion
 * @property {{language:string, sources:object, settings:object}} input
 * @property {{contracts: Record<string, Record<string, {abi:any[]}>>}} [output]
 */

import fs from 'node:fs';
import { Interface } from 'ethers';

/**
 * Read + parse a Hardhat build-info file from disk.
 * @param {string} filePath
 * @returns {BuildInfo}
 */
export function loadBuildInfo(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed.input || !parsed.input.sources) {
    throw new Error(`loadBuildInfo: ${filePath} is not a Hardhat build-info (no input.sources)`);
  }
  return parsed;
}

/**
 * Find the fully-qualified contract id ("<path>:<Name>") for a contract name
 * inside a build-info's output, and return its ABI too.
 * @param {BuildInfo} buildInfo
 * @param {string} contractName
 * @returns {{ contractPath: string, abi: any[] }}
 */
function locateContract(buildInfo, contractName) {
  const out = buildInfo.output?.contracts;
  if (!out) {
    throw new Error(
      'verification-helper: build-info has no output.contracts; ' +
        'pass `abi` explicitly so constructor args can be encoded',
    );
  }
  const matches = [];
  for (const [sourcePath, contracts] of Object.entries(out)) {
    if (Object.prototype.hasOwnProperty.call(contracts, contractName)) {
      matches.push({ contractPath: `${sourcePath}:${contractName}`, abi: contracts[contractName].abi });
    }
  }
  if (matches.length === 0) {
    throw new Error(`verification-helper: contract "${contractName}" not found in build-info output`);
  }
  if (matches.length > 1) {
    throw new Error(
      `verification-helper: contract "${contractName}" is ambiguous (${matches.length} sources): ` +
        matches.map((m) => m.contractPath).join(', '),
    );
  }
  return matches[0];
}

/**
 * ABI-encode constructor arguments using the contract's ABI.
 * Returns a hex string WITHOUT a leading "0x" (explorer convention).
 * Empty args -> "".
 * @param {any[]} abi
 * @param {any[]} constructorArgs
 * @returns {string}
 */
export function encodeConstructorArgs(abi, constructorArgs = []) {
  if (!constructorArgs || constructorArgs.length === 0) return '';
  const iface = new Interface(abi);
  const ctor = iface.deploy; // ethers v6: ConstructorFragment
  if (!ctor || !ctor.inputs || ctor.inputs.length === 0) {
    if (constructorArgs.length > 0) {
      throw new Error(
        `encodeConstructorArgs: ${constructorArgs.length} arg(s) given but ABI has no constructor inputs`,
      );
    }
    return '';
  }
  const encoded = iface.encodeDeploy(constructorArgs); // includes nothing but the encoded args
  return encoded.startsWith('0x') ? encoded.slice(2) : encoded;
}

/**
 * Pure core: produce an explorer standard-JSON verification request payload.
 *
 * @param {Object} args
 * @param {string} args.contractName       e.g. "ERC20Base"
 * @param {string} args.address            deployed address
 * @param {any[]}  [args.constructorArgs]  constructor args (default [])
 * @param {BuildInfo} args.buildInfo       parsed Hardhat build-info object
 * @param {any[]} [args.abi]               override ABI for ctor encoding (else from output)
 * @param {string} [args.contractPath]     override fully-qualified id "<path>:<Name>"
 * @returns {{
 *   address: string,
 *   compilerVersion: string,
 *   standardJsonInput: object,
 *   contractPath: string,
 *   constructorArgsHex: string
 * }}
 */
export function buildVerificationPayload({
  contractName,
  address,
  constructorArgs = [],
  buildInfo,
  abi,
  contractPath,
}) {
  if (!contractName) throw new Error('buildVerificationPayload: contractName is required');
  if (!address) throw new Error('buildVerificationPayload: address is required');
  if (!buildInfo || !buildInfo.input) {
    throw new Error('buildVerificationPayload: buildInfo (with .input) is required');
  }

  // The standard-JSON input is the build-info `input` block verbatim — it
  // already carries language, sources, and settings (optimizer/evmVersion/etc).
  const standardJsonInput = buildInfo.input;

  // Compiler version: explorers want the long, commit-pinned form prefixed "v".
  const long = buildInfo.solcLongVersion || buildInfo.solcVersion;
  if (!long) throw new Error('buildVerificationPayload: build-info has no solc version');
  const compilerVersion = long.startsWith('v') ? long : `v${long}`;

  // Resolve ABI + fully-qualified path. If caller supplies both, skip output lookup.
  let resolvedAbi = abi;
  let resolvedPath = contractPath;
  if (!resolvedAbi || !resolvedPath) {
    const located = locateContract(buildInfo, contractName);
    resolvedAbi = resolvedAbi || located.abi;
    resolvedPath = resolvedPath || located.contractPath;
  }

  const constructorArgsHex = encodeConstructorArgs(resolvedAbi, constructorArgs);

  return {
    address,
    compilerVersion,
    standardJsonInput,
    contractPath: resolvedPath,
    constructorArgsHex,
  };
}

export default { loadBuildInfo, buildVerificationPayload, encodeConstructorArgs };
