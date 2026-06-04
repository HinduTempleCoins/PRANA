#!/usr/bin/env node
/**
 * vanity.mjs — split-key BIP-32-child vanity-address derivation for the Akasha wallet.
 *
 * WHY THIS EXISTS (read design/research/G22-profanity-vanity.md):
 *   Naive GPU vanity generators ("brute-force private keys until the address is pretty")
 *   are a key-recovery time bomb — the Profanity tool's reduced-entropy seed let attackers
 *   reverse-derive keys (Wintermute, ~$160M). The whole search runs on a machine that sees
 *   the private key in cleartext, so outsourcing it hands over the key.
 *
 * THE SAFE PATTERN — split-key (secp256k1 point addition):
 *   1. The USER generates a full-entropy private scalar `s` locally/offline and computes the
 *      PUBLIC point S = s·G. Only S (a public key) is ever shared — never `s`.
 *   2. A SEARCHER (possibly untrusted: a GPU farm or public service) brute-forces a
 *      complementary scalar `d` such that address(S + d·G) matches the desired pattern. The
 *      searcher only handles PUBLIC points + the public `d`; it never sees `s`, so it cannot
 *      compute the final key.
 *   3. The user, OFFLINE, combines: p = (s + d) mod n. The vanity address = address(p·G).
 *   Because `s` never left the user and `d` alone is useless, the searcher learns nothing.
 *
 * This module provides the math for ALL THREE roles, with the security-critical combine step
 * (which needs `s`) clearly separated from the searchable step (which needs only S). The
 * derived child scalar `d` here is itself drawn from a full-entropy CSPRNG (we do NOT reduce
 * entropy the way Profanity did) — so even a brute-force search never enumerates a small space.
 *
 * Crypto is delegated to vetted libraries: ethers v6 (SigningKey / computeAddress) for key and
 * address derivation, and @noble/curves/secp256k1 for the EC point addition ethers does not
 * expose. We never hand-roll AES, scrypt, RNG, or curve arithmetic.
 *
 * CLI usage (optional; the exported functions are the real API):
 *   node tools/vanity.mjs --prefix dead --max 5000000
 *     → generates a fresh user scalar, searches for `d`, prints the vanity address and
 *       (only when --reveal-key is passed) the combined private key. By default it prints
 *       the address + the public material so the merge can be done in an air-gapped step.
 */

import { SigningKey, computeAddress, getAddress, hexlify, randomBytes } from 'ethers';
import { secp256k1 } from '@noble/curves/secp256k1';

// secp256k1 group order. Scalars are taken mod n.
const N = secp256k1.CURVE.n;
const Point = secp256k1.ProjectivePoint;

// ----------------------------------------------------------------------------
// low-level scalar / point helpers
// ----------------------------------------------------------------------------

function toHex32(x) {
  if (typeof x !== 'bigint') throw new TypeError('scalar must be a bigint');
  return '0x' + x.toString(16).padStart(64, '0');
}

/** A full-entropy non-zero scalar in [1, n-1] drawn from the platform CSPRNG (32 bytes). */
function randomScalar() {
  for (;;) {
    const x = BigInt(hexlify(randomBytes(32))) % N;
    if (x !== 0n) return x;
  }
}

/**
 * Generate the USER half. Returns the secret scalar `s` (KEEP OFFLINE) and the public point S
 * (uncompressed, 0x04…) that is the ONLY thing handed to a searcher.
 */
export function makeUserKey() {
  const s = randomScalar();
  const publicPoint = SigningKey.computePublicKey(toHex32(s), false); // uncompressed 0x04..
  return { secretScalar: toHex32(s), publicPoint };
}

/**
 * Compute the candidate address for a given user public point S and searcher scalar `d`,
 * WITHOUT any private scalar. address(S + d·G). This is the function the (untrusted) searcher
 * runs in its hot loop — it touches only public material.
 */
export function addressForChild(publicPoint, dScalarHex) {
  const d = BigInt(dScalarHex) % N;
  const S = Point.fromHex(publicPoint.slice(2));
  const P = S.add(Point.BASE.multiply(d)); // S + d·G
  return computeAddress('0x' + P.toHex(false));
}

/**
 * Combine the two halves into the final private key. THIS IS THE SECURITY-CRITICAL STEP and
 * MUST be run offline/air-gapped (a compromised online environment here sees both halves).
 * p = (s + d) mod n. Returns the private key and its address; throws if the address does not
 * match `expectedAddress` (a guard against modular-arithmetic / wrong-half bugs).
 */
export function combineKeys(secretScalarHex, dScalarHex, expectedAddress) {
  const s = BigInt(secretScalarHex) % N;
  const d = BigInt(dScalarHex) % N;
  const p = (s + d) % N;
  if (p === 0n) throw new Error('degenerate combined scalar (s + d ≡ 0 mod n); retry');
  const privateKey = toHex32(p);
  const address = computeAddress(privateKey);
  if (expectedAddress && getAddress(expectedAddress) !== address) {
    throw new Error(
      `combined address ${address} != expected ${getAddress(expectedAddress)}`
    );
  }
  return { privateKey, address };
}

// ----------------------------------------------------------------------------
// pattern matching
// ----------------------------------------------------------------------------

/** Normalise a hex vanity pattern: strip 0x, lowercase, validate it is hex. */
function normalizePattern(p) {
  const h = String(p).replace(/^0x/i, '').toLowerCase();
  if (h.length === 0) throw new Error('empty pattern');
  if (!/^[0-9a-f]+$/.test(h)) throw new Error(`pattern must be hex: ${p}`);
  return h;
}

/** Does `address` match `prefix`/`suffix` (case-insensitive, after the 0x)? */
export function matches(address, { prefix, suffix } = {}) {
  const hex = address.slice(2).toLowerCase();
  if (prefix && !hex.startsWith(normalizePattern(prefix))) return false;
  if (suffix && !hex.endsWith(normalizePattern(suffix))) return false;
  return true;
}

/**
 * The SEARCHER loop. Given only the user's PUBLIC point, brute-force fresh full-entropy child
 * scalars `d` until address(S + d·G) matches the pattern, or `maxTries` is exhausted. Returns
 * the winning `d` (public) and the resulting address. Never sees / needs a private scalar.
 *
 * @param {string} publicPoint  uncompressed user public point (0x04…), from makeUserKey()
 * @param {{prefix?:string,suffix?:string}} pattern
 * @param {{maxTries?:number, rng?:()=>bigint}} [opts]
 */
export function searchChild(publicPoint, pattern, opts = {}) {
  const maxTries = opts.maxTries ?? 2_000_000;
  const nextScalar = opts.rng ?? randomScalar;
  if (!pattern || (!pattern.prefix && !pattern.suffix)) {
    throw new Error('pattern needs a prefix and/or suffix');
  }
  // Validate patterns up front so a bad pattern fails fast, not after a long search.
  if (pattern.prefix) normalizePattern(pattern.prefix);
  if (pattern.suffix) normalizePattern(pattern.suffix);

  const S = Point.fromHex(publicPoint.slice(2));
  for (let tries = 1; tries <= maxTries; tries++) {
    const d = nextScalar() % N;
    if (d === 0n) continue;
    const address = computeAddress('0x' + S.add(Point.BASE.multiply(d)).toHex(false));
    if (matches(address, pattern)) {
      return { childScalar: toHex32(d), address, tries };
    }
  }
  return null; // not found within budget
}

/**
 * End-to-end convenience for a TRUSTED single-machine run (e.g. a local wallet that searches
 * on its own machine). Generates the user half, searches, and — only if `combine` is true —
 * merges to the final private key. In the split/outsourced model you would instead call
 * makeUserKey() locally, ship `publicPoint` to the searcher, get back `childScalar`, and call
 * combineKeys() offline yourself.
 */
export function generateVanity(pattern, opts = {}) {
  const user = makeUserKey();
  const found = searchChild(user.publicPoint, pattern, opts);
  if (!found) return null;
  const out = {
    address: found.address,
    publicPoint: user.publicPoint,
    childScalar: found.childScalar, // public — safe to log
    tries: found.tries,
  };
  if (opts.combine) {
    out.privateKey = combineKeys(
      user.secretScalar,
      found.childScalar,
      found.address
    ).privateKey;
  }
  return out;
}

// ----------------------------------------------------------------------------
// CLI (optional)
// ----------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { maxTries: 2_000_000, combine: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prefix') out.prefix = argv[++i];
    else if (a === '--suffix') out.suffix = argv[++i];
    else if (a === '--max') out.maxTries = Number(argv[++i]);
    else if (a === '--reveal-key') out.combine = true;
  }
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.prefix && !a.suffix) {
    console.error('usage: vanity.mjs --prefix <hex> [--suffix <hex>] [--max N] [--reveal-key]');
    process.exit(2);
  }
  const res = generateVanity(
    { prefix: a.prefix, suffix: a.suffix },
    { maxTries: a.maxTries, combine: a.combine }
  );
  if (!res) {
    console.error(`no match within ${a.maxTries} tries — shorten the pattern or raise --max`);
    process.exit(1);
  }
  console.log('address      :', res.address);
  console.log('publicPoint  :', res.publicPoint);
  console.log('childScalar  :', res.childScalar, '(public — give to nobody-sensitive)');
  console.log('tries        :', res.tries);
  if (res.privateKey) {
    console.log('privateKey   :', res.privateKey, '(SECRET — only printed with --reveal-key)');
  } else {
    console.log('(no key revealed; combine offline with combineKeys(secretScalar, childScalar))');
  }
}

// Only run the CLI when invoked directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
