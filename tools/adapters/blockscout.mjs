// W8 — Blockscout contract-verification payload builder + client.
//
// Builds the request shape for Blockscout's standard-JSON-input verification
// endpoint, submits it, and polls status. Includes a helper to extract the
// solc Standard JSON Input from a Hardhat build-info artifact.
//
// Softly depends on ./base.mjs for typed errors + fixture plumbing.

import { readFile } from "node:fs/promises";

let base;
try {
  base = await import("./base.mjs");
} catch {
  base = null;
}

class FallbackAdapterError extends Error {
  constructor(message, { code, status, cause, details } = {}) {
    super(message);
    this.name = "AdapterError";
    if (cause !== undefined) this.cause = cause;
    this.details = { ...(details ?? {}), ...(code ? { code } : {}), ...(status != null ? { status } : {}) };
    if (code) this.code = code;
    if (status != null) this.status = status;
  }
}
const BaseAdapterError = base?.AdapterError ?? FallbackAdapterError;

export class AdapterError extends BaseAdapterError {
  constructor(message, opts = {}) {
    super(message, opts);
    if (opts.code) this.code = opts.code;
    if (opts.status != null) this.status = opts.status;
  }
}

export class BlockscoutHttpError extends AdapterError {
  constructor(message, status, body) {
    super(message, { code: "BLOCKSCOUT_HTTP", status });
    this.name = "BlockscoutHttpError";
    this.body = body;
  }
}

function fixtureModeOn() {
  return process.env.ADAPTER_FIXTURE_MODE === "1";
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Build the JSON body for Blockscout's
 *   POST /api/v2/smart-contracts/{address}/verification/via/standard-input
 *
 * Pure — no I/O. Unit-tested directly with fixtures.
 *
 * @param {object} p
 * @param {string} p.address                contract address (0x...)
 * @param {string} p.contractName           "path/File.sol:Contract" or "Contract"
 * @param {string} p.compilerVersion        e.g. "v0.8.24+commit.e11b9ed9"
 * @param {object|string} p.standardJsonInput  solc Standard JSON Input (object or JSON string)
 * @param {string[]} [p.constructorArgs]    ABI-encoded constructor args (hex, no 0x) OR []
 * @param {boolean} [p.autodetectConstructorArgs]
 * @param {string} [p.licenseType]
 * @returns {{ address: string, body: object }}
 */
export function buildStandardJsonVerification({
  address,
  contractName,
  compilerVersion,
  standardJsonInput,
  constructorArgs,
  autodetectConstructorArgs,
  licenseType,
} = {}) {
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) {
    throw new AdapterError("address must be a 0x-prefixed 40-hex-char string", {
      code: "BLOCKSCOUT_BAD_ADDRESS",
    });
  }
  if (!contractName) {
    throw new AdapterError("contractName required", { code: "BLOCKSCOUT_BAD_NAME" });
  }
  if (!compilerVersion) {
    throw new AdapterError("compilerVersion required", { code: "BLOCKSCOUT_BAD_COMPILER" });
  }
  // Blockscout expects the standard input serialized as a JSON string.
  let inputStr;
  if (typeof standardJsonInput === "string") {
    inputStr = standardJsonInput;
  } else if (standardJsonInput && typeof standardJsonInput === "object") {
    inputStr = JSON.stringify(standardJsonInput);
  } else {
    throw new AdapterError("standardJsonInput must be an object or JSON string", {
      code: "BLOCKSCOUT_BAD_INPUT",
    });
  }

  // Normalize compilerVersion to Blockscout's expected "vX.Y.Z+commit.hash".
  const normalizedCompiler = /^v/.test(compilerVersion)
    ? compilerVersion
    : `v${compilerVersion}`;

  const body = {
    compiler_version: normalizedCompiler,
    contract_name: contractName,
    files: {
      // standard-input verification ships the whole input as a single file blob
      "standard-input.json": inputStr,
    },
  };

  if (autodetectConstructorArgs) {
    body.autodetect_constructor_args = true;
  } else if (Array.isArray(constructorArgs)) {
    body.constructor_args = constructorArgs.join("");
  } else if (typeof constructorArgs === "string") {
    body.constructor_args = constructorArgs.replace(/^0x/, "");
  }
  if (licenseType) body.license_type = licenseType;

  return { address, body };
}

/**
 * Extract the solc Standard JSON Input (and metadata) from a Hardhat build-info
 * file. The build-info `input` field IS already a valid solc Standard JSON
 * Input. Returns { standardJsonInput, solcVersion, solcLongVersion, compilerVersion }.
 *
 * @param {string} path  path to a contracts/artifacts/build-info/*.json file
 */
export async function readBuildInfoStandardInput(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    throw new AdapterError(`cannot read build-info file: ${cause.message}`, {
      code: "BLOCKSCOUT_BUILDINFO_READ",
      cause,
    });
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new AdapterError(`build-info is not valid JSON: ${cause.message}`, {
      code: "BLOCKSCOUT_BUILDINFO_PARSE",
      cause,
    });
  }
  return extractStandardInput(json);
}

/** Pure extractor over a parsed build-info object (unit-tested with fixtures). */
export function extractStandardInput(buildInfo) {
  if (!buildInfo || typeof buildInfo !== "object") {
    throw new AdapterError("build-info must be an object", {
      code: "BLOCKSCOUT_BUILDINFO_SHAPE",
    });
  }
  const { input, solcVersion, solcLongVersion } = buildInfo;
  if (!input || input.language !== "Solidity" || !input.sources) {
    throw new AdapterError(
      "build-info.input is not a Solidity Standard JSON Input",
      { code: "BLOCKSCOUT_BUILDINFO_SHAPE" }
    );
  }
  return {
    standardJsonInput: input,
    solcVersion: solcVersion ?? null,
    solcLongVersion: solcLongVersion ?? null,
    // Blockscout-ready compiler version string.
    compilerVersion: solcLongVersion ? `v${solcLongVersion}` : null,
  };
}

// ---- network client --------------------------------------------------------

export const DEFAULT_BASE_URL = "http://localhost:4000";

async function request(baseUrl, method, path, body, opts = {}) {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const doFetch = opts.fetchImpl ?? fetch;
  let res;
  try {
    res = await doFetch(url, {
      method,
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (cause) {
    throw new AdapterError(`Blockscout request failed: ${cause.message}`, {
      code: "BLOCKSCOUT_NETWORK",
      cause,
    });
  }
  let text;
  let json;
  try {
    text = await res.text();
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new BlockscoutHttpError(
      `Blockscout non-JSON response (status ${res.status})`,
      res.status,
      text
    );
  }
  if (!res.ok) {
    throw new BlockscoutHttpError(
      `Blockscout HTTP ${res.status}: ${json?.message ?? text}`,
      res.status,
      json
    );
  }
  return json;
}

/**
 * Submit a standard-JSON-input verification request.
 * Returns the Blockscout response (typically { message } acknowledging queueing).
 */
export async function submitVerification(params, opts = {}) {
  const { address, body } = buildStandardJsonVerification(params);
  if (fixtureModeOn() || opts.fixture !== undefined) {
    return opts.fixture ?? { message: "Verification started", status: "0", _fixture: true };
  }
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  return request(
    baseUrl,
    "POST",
    `/api/v2/smart-contracts/${address}/verification/via/standard-input`,
    body,
    opts
  );
}

/**
 * Check verification status for a contract address.
 * Returns { isVerified, raw }.
 */
export async function checkStatus(address, opts = {}) {
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) {
    throw new AdapterError("address must be a 0x-prefixed 40-hex-char string", {
      code: "BLOCKSCOUT_BAD_ADDRESS",
    });
  }
  if (fixtureModeOn() || opts.fixture !== undefined) {
    const fx = opts.fixture ?? { is_verified: false, _fixture: true };
    return { isVerified: !!fx.is_verified, raw: fx };
  }
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const json = await request(baseUrl, "GET", `/api/v2/smart-contracts/${address}`, undefined, opts);
  return { isVerified: !!json?.is_verified, raw: json };
}

export default {
  DEFAULT_BASE_URL,
  buildStandardJsonVerification,
  readBuildInfoStandardInput,
  extractStandardInput,
  submitVerification,
  checkStatus,
  BlockscoutHttpError,
};
