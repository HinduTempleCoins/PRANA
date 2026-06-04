// SPDX-License-Identifier: MIT
/**
 * Sign-In With Ethereum (EIP-4361) — dependency-light ESM implementation.
 *
 * Shared auth primitive for token-gated rooms and wallet login. Produces and
 * parses the exact EIP-4361 ABNF message string, and verifies signatures with
 * ethers v6 `verifyMessage`.
 *
 * Reference: https://eips.ethereum.org/EIPS/eip-4361
 *
 * The only runtime dependency is ethers (for `verifyMessage`, `getAddress`).
 * Message building/parsing is pure string work with no external deps.
 *
 * @module siwe
 */

import { verifyMessage, getAddress } from "ethers";

/**
 * @typedef {Object} SiweFields
 * @property {string} domain        RFC 4501 dnsauthority requesting the signing (e.g. "example.com").
 * @property {string} address       EIP-55 checksummed 0x address of the signer.
 * @property {string} [statement]   Optional human-readable assertion shown to the user.
 * @property {string} uri           RFC 3986 URI referring to the resource being signed in to.
 * @property {string|number} version  EIP-4361 version. Always "1" today.
 * @property {string|number} chainId  EIP-155 chain id the signature is scoped to.
 * @property {string} nonce         Randomized token (>= 8 alphanumeric chars) for replay protection.
 * @property {string} issuedAt      ISO-8601 datetime when the message was generated.
 * @property {string} [expirationTime]  ISO-8601 datetime after which the message is invalid.
 * @property {string} [notBefore]   ISO-8601 datetime before which the message is invalid.
 * @property {string} [requestId]   Optional system-specific request identifier.
 * @property {string[]} [resources] Optional list of RFC 3986 URIs the signature is scoped to.
 */

const PREAMBLE_SUFFIX =
  " wants you to sign in with your Ethereum account:";

/**
 * Generate a cryptographically-random alphanumeric nonce for SIWE replay protection.
 *
 * @param {number} [length=16]  Number of characters (EIP-4361 requires >= 8).
 * @returns {string} alphanumeric nonce.
 */
export function generateNonce(length = 16) {
  if (!Number.isInteger(length) || length < 8) {
    throw new Error("nonce length must be an integer >= 8");
  }
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  // Prefer Web Crypto (Node 19+, browsers); fall back to Math.random only if absent.
  const out = new Array(length);
  const cryptoObj =
    (typeof globalThis !== "undefined" && globalThis.crypto) || undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    const buf = new Uint8Array(length);
    cryptoObj.getRandomValues(buf);
    for (let i = 0; i < length; i++) {
      out[i] = alphabet[buf[i] % alphabet.length];
    }
  } else {
    for (let i = 0; i < length; i++) {
      out[i] = alphabet[Math.floor(Math.random() * alphabet.length)];
    }
  }
  return out.join("");
}

/**
 * Validate that a string is a plausible ISO-8601 datetime (EIP-4361 uses RFC 3339).
 * @param {string} value
 * @param {string} field
 */
function assertDateTime(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty ISO-8601 string`);
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} is not a valid ISO-8601 datetime: ${value}`);
  }
}

/**
 * Build the canonical EIP-4361 message string from its fields.
 *
 * The output matches the EIP-4361 ABNF exactly: the preamble line, the address
 * line, a blank line, the optional statement, a blank line, then `key: value`
 * advisory fields in canonical order, and finally the optional `Resources:`
 * block (one `- <uri>` per line).
 *
 * @param {SiweFields} fields
 * @returns {string} the message to be signed.
 */
export function buildMessage(fields) {
  if (!fields || typeof fields !== "object") {
    throw new Error("buildMessage requires a fields object");
  }
  const {
    domain,
    address,
    statement,
    uri,
    version,
    chainId,
    nonce,
    issuedAt,
    expirationTime,
    notBefore,
    requestId,
    resources,
  } = fields;

  if (!domain || typeof domain !== "string") {
    throw new Error("domain is required");
  }
  if (domain.includes("\n")) throw new Error("domain must be a single line");
  if (!uri || typeof uri !== "string") throw new Error("uri is required");
  if (version === undefined || version === null || `${version}` === "") {
    throw new Error("version is required");
  }
  if (chainId === undefined || chainId === null || `${chainId}` === "") {
    throw new Error("chainId is required");
  }
  if (!nonce || typeof nonce !== "string" || nonce.length < 8) {
    throw new Error("nonce is required and must be >= 8 chars");
  }
  assertDateTime(issuedAt, "issuedAt");

  // Checksum the address; this both validates it and yields the EIP-55 form
  // that EIP-4361 mandates on the address line.
  const checksummed = getAddress(address);

  if (statement !== undefined && statement !== null) {
    if (typeof statement !== "string") {
      throw new Error("statement must be a string");
    }
    if (statement.includes("\n")) {
      throw new Error("statement must be a single line");
    }
  }
  if (expirationTime !== undefined && expirationTime !== null) {
    assertDateTime(expirationTime, "expirationTime");
  }
  if (notBefore !== undefined && notBefore !== null) {
    assertDateTime(notBefore, "notBefore");
  }

  const lines = [];
  lines.push(`${domain}${PREAMBLE_SUFFIX}`);
  lines.push(checksummed);
  lines.push(""); // blank line after the address line

  // Statement is optional; when present it sits alone on its own line, followed
  // by a blank line. When absent, EIP-4361 still keeps a blank separator.
  if (statement !== undefined && statement !== null) {
    lines.push(statement);
  }
  lines.push("");

  lines.push(`URI: ${uri}`);
  lines.push(`Version: ${version}`);
  lines.push(`Chain ID: ${chainId}`);
  lines.push(`Nonce: ${nonce}`);
  lines.push(`Issued At: ${issuedAt}`);

  if (expirationTime !== undefined && expirationTime !== null) {
    lines.push(`Expiration Time: ${expirationTime}`);
  }
  if (notBefore !== undefined && notBefore !== null) {
    lines.push(`Not Before: ${notBefore}`);
  }
  if (requestId !== undefined && requestId !== null) {
    lines.push(`Request ID: ${requestId}`);
  }
  if (resources !== undefined && resources !== null) {
    if (!Array.isArray(resources)) {
      throw new Error("resources must be an array of URI strings");
    }
    lines.push("Resources:");
    for (const r of resources) {
      if (typeof r !== "string") {
        throw new Error("each resource must be a string");
      }
      lines.push(`- ${r}`);
    }
  }

  return lines.join("\n");
}

const PREAMBLE_RE = new RegExp(
  `^(?<domain>[^\\n]+?) wants you to sign in with your Ethereum account:$`
);

/**
 * Parse a canonical EIP-4361 message string back into its fields. Inverse of
 * {@link buildMessage}. Throws on structural violations.
 *
 * @param {string} message
 * @returns {SiweFields} the recovered fields.
 */
export function parseMessage(message) {
  if (typeof message !== "string") {
    throw new Error("parseMessage requires a string");
  }
  const lines = message.split("\n");
  let i = 0;

  const preamble = lines[i++] ?? "";
  const preMatch = PREAMBLE_RE.exec(preamble);
  if (!preMatch || !preMatch.groups) {
    throw new Error("invalid SIWE message: bad preamble line");
  }
  const domain = preMatch.groups.domain;

  const addressLine = lines[i++];
  if (addressLine === undefined) {
    throw new Error("invalid SIWE message: missing address line");
  }
  // Validate + normalize via checksum (throws on a malformed address).
  const address = getAddress(addressLine);

  if (lines[i++] !== "") {
    throw new Error("invalid SIWE message: expected blank line after address");
  }

  // Statement is optional. If the next line is non-empty it is the statement,
  // and it must be followed by a blank line. If it is empty, there is no
  // statement and that empty line is the separator.
  let statement;
  if (lines[i] !== "" && lines[i] !== undefined) {
    statement = lines[i++];
    if (lines[i++] !== "") {
      throw new Error(
        "invalid SIWE message: expected blank line after statement"
      );
    }
  } else {
    // consume the single blank separator line
    i++;
  }

  /** @type {Record<string,string>} */
  const kv = {};
  let resources;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === "Resources:") {
      resources = [];
      for (i++; i < lines.length; i++) {
        const rline = lines[i];
        if (!rline.startsWith("- ")) {
          throw new Error(
            "invalid SIWE message: malformed Resources entry: " + rline
          );
        }
        resources.push(rline.slice(2));
      }
      break;
    }
    const sep = line.indexOf(": ");
    if (sep === -1) {
      throw new Error("invalid SIWE message: malformed field line: " + line);
    }
    const key = line.slice(0, sep);
    const value = line.slice(sep + 2);
    kv[key] = value;
  }

  if (!("URI" in kv)) throw new Error("invalid SIWE message: missing URI");
  if (!("Version" in kv)) throw new Error("invalid SIWE message: missing Version");
  if (!("Chain ID" in kv)) throw new Error("invalid SIWE message: missing Chain ID");
  if (!("Nonce" in kv)) throw new Error("invalid SIWE message: missing Nonce");
  if (!("Issued At" in kv)) throw new Error("invalid SIWE message: missing Issued At");

  /** @type {SiweFields} */
  const fields = {
    domain,
    address,
    uri: kv["URI"],
    version: kv["Version"],
    chainId: kv["Chain ID"],
    nonce: kv["Nonce"],
    issuedAt: kv["Issued At"],
  };
  if (statement !== undefined) fields.statement = statement;
  if ("Expiration Time" in kv) fields.expirationTime = kv["Expiration Time"];
  if ("Not Before" in kv) fields.notBefore = kv["Not Before"];
  if ("Request ID" in kv) fields.requestId = kv["Request ID"];
  if (resources !== undefined) fields.resources = resources;

  return fields;
}

/**
 * @typedef {Object} VerifyResult
 * @property {boolean} success   True when the signature is valid and the message is in its validity window.
 * @property {SiweFields} [fields]  Parsed fields (present whenever the message parsed).
 * @property {string} [recovered]  EIP-55 address recovered from the signature (present when parse succeeded).
 * @property {string} [error]    Human-readable failure reason when `success` is false.
 */

/**
 * Verify a SIWE message + signature.
 *
 * Performs three checks:
 *  1. The message parses as canonical EIP-4361.
 *  2. `verifyMessage` recovers an address equal to the message's `address` field.
 *  3. The current time (or `now`) is within `[notBefore, expirationTime]` if those are set.
 *
 * @param {Object} params
 * @param {string} params.message    The exact signed message string.
 * @param {string} params.signature  65-byte hex signature from a wallet.
 * @param {Date|number} [params.now] Override "current time" (Date or ms epoch) for testing/skew.
 * @param {string} [params.expectedNonce]  If given, require the message nonce to equal this.
 * @param {string} [params.expectedDomain] If given, require the message domain to equal this.
 * @returns {VerifyResult}
 */
export function verify({ message, signature, now, expectedNonce, expectedDomain } = {}) {
  /** @type {SiweFields} */
  let fields;
  try {
    fields = parseMessage(message);
  } catch (err) {
    return { success: false, error: `parse failed: ${err.message}` };
  }

  let recovered;
  try {
    recovered = verifyMessage(message, signature);
  } catch (err) {
    return { success: false, fields, error: `signature invalid: ${err.message}` };
  }

  if (getAddress(recovered) !== getAddress(fields.address)) {
    return {
      success: false,
      fields,
      recovered,
      error: "signature does not match the message address",
    };
  }

  if (expectedNonce !== undefined && fields.nonce !== expectedNonce) {
    return { success: false, fields, recovered, error: "nonce mismatch" };
  }
  if (expectedDomain !== undefined && fields.domain !== expectedDomain) {
    return { success: false, fields, recovered, error: "domain mismatch" };
  }

  const nowMs =
    now === undefined
      ? Date.now()
      : now instanceof Date
        ? now.getTime()
        : Number(now);

  if (fields.notBefore !== undefined) {
    const nb = Date.parse(fields.notBefore);
    if (nowMs < nb) {
      return { success: false, fields, recovered, error: "message not yet valid (Not Before)" };
    }
  }
  if (fields.expirationTime !== undefined) {
    const exp = Date.parse(fields.expirationTime);
    if (nowMs >= exp) {
      return { success: false, fields, recovered, error: "message expired (Expiration Time)" };
    }
  }

  return { success: true, fields, recovered };
}

export default { buildMessage, parseMessage, verify, generateNonce };
