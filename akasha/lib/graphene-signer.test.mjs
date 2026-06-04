// akasha/lib/graphene-signer.test.mjs
//
// node:test suite for the Graphene signer (AK2) + key tiers (AK3).
// Run: `node --test` from akasha/, or `node --test lib/graphene-signer.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  signerFor,
  signerFromWif,
  exportWif,
  publicKeyOf,
  verify,
  verifyWithPubKey,
  wifToPriv,
  publicKeyStringToBytes,
  DEFAULT_PREFIX,
  nobleAdapter,
} from "./graphene-signer.mjs";

import {
  ROLES,
  TIER_POLICY,
  deriveAllTiers,
  derivePublicTiers,
  tierForOperation,
  roleSatisfies,
  requireRole,
} from "./graphene-keytiers.mjs";

// ---------------------------------------------------------------------------
// Deterministic fixture. Generated from the verified Graphene KDF
//   priv = sha256(account + role + password)
// with prefix "MELEK". These are self-consistent vectors: if the derivation,
// WIF encoding, or pubkey encoding regresses, these break. (The algorithm itself
// is the documented Steem/Hive/BLURT brain-key derivation — see the spec.)
// ---------------------------------------------------------------------------
const ACCOUNT = "alice";
const TEST_PASSPHRASE = "P5KMy2Sh4t9x7VkqW8j3nF6dBcGzReTpLuAo1iQwXyZ2mNvHsbk";

const EXPECT_PUBKEY = {
  owner: "MELEK5R4XJEUue46N25TzAQezbynMsmz9GnesnHbFUYUujE6NY7UHA4",
  active: "MELEK6VctfhKnUg85BpXeAKp6kpgyhjVSKVcanSMPmgs9W7UmNPyRQn",
  posting: "MELEK5xAFSpu8hPjnqtp7Me5QCvGQ9d4g3iqTfvnnSu1AsGXtiFRR1k",
  memo: "MELEK7JGUfqPMbgMwjdQKZt9nDp5vrRxst44K34XWZScvVTW2fuJTG4",
};
const EXPECT_WIF_ACTIVE = "5JyabeLLhHRuYbzSJkpj1fTPgSPfVsdkK1rCvBhKYXU7GywkYXA";

// ---------------------------------------------------------------------------
// Derivation determinism / known vectors
// ---------------------------------------------------------------------------

test("default prefix is MELEK", () => {
  assert.equal(DEFAULT_PREFIX, "MELEK");
});

test("public-key strings are deterministic for the fixed (account,password)", () => {
  for (const role of ROLES) {
    const s = signerFor(ACCOUNT, role, TEST_PASSPHRASE, { prefix: "MELEK" });
    assert.equal(s.getAddress(), EXPECT_PUBKEY[role], `role ${role}`);
    assert.equal(s.getPublicWif(), EXPECT_PUBKEY[role], `getPublicWif ${role}`);
    s.wipe();
  }
});

test("exported WIF is deterministic and round-trips through wifToPriv", () => {
  const wif = exportWif(ACCOUNT, "active", TEST_PASSPHRASE);
  assert.equal(wif, EXPECT_WIF_ACTIVE);

  // WIF -> priv -> signer -> same public key as direct derivation.
  const priv = wifToPriv(wif);
  assert.equal(priv.length, 32);
  const reSigner = signerFromWif(wif, { prefix: "MELEK", role: "active" });
  assert.equal(reSigner.getAddress(), EXPECT_PUBKEY.active);
  reSigner.wipe();
});

test("publicKeyOf matches signerFor.getAddress (no signer retained)", () => {
  assert.equal(publicKeyOf(ACCOUNT, "posting", TEST_PASSPHRASE), EXPECT_PUBKEY.posting);
});

test("public-key string parses back to the compressed pubkey bytes", () => {
  const s = signerFor(ACCOUNT, "owner", TEST_PASSPHRASE);
  const bytes = publicKeyStringToBytes(s.getAddress(), { prefix: "MELEK" });
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes.length, 33);
  assert.deepEqual(bytes, s.publicKeyBytes());
  s.wipe();
});

test("a tampered public-key string fails the ripemd160 checksum", () => {
  const good = EXPECT_PUBKEY.active;
  const bad = good.slice(0, -1) + (good.endsWith("n") ? "m" : "n");
  assert.equal(publicKeyStringToBytes(bad, { prefix: "MELEK" }), null);
});

// ---------------------------------------------------------------------------
// Sign / verify round-trips
// ---------------------------------------------------------------------------

test("signDigest + verify round-trips", () => {
  const s = signerFor(ACCOUNT, "posting", TEST_PASSPHRASE);
  const digest = new Uint8Array(32).fill(7);
  const sig = s.signDigest(digest);
  // 65-byte recoverable sig = 130 hex chars.
  assert.equal(sig.length, 130);
  assert.equal(verify(digest, sig, s.getAddress()), true);
  s.wipe();
});

test("signMessage hashes then signs, and verifies against the digest", () => {
  const s = signerFor(ACCOUNT, "active", TEST_PASSPHRASE);
  const sig = s.signMessage("hello prana");
  const digest = nobleAdapter.sha256(new TextEncoder().encode("hello prana"));
  assert.equal(verify(digest, sig, s.getAddress()), true);
  s.wipe();
});

test("signatures are deterministic (RFC-6979)", () => {
  const s = signerFor(ACCOUNT, "active", TEST_PASSPHRASE);
  const digest = new Uint8Array(32).fill(42);
  assert.equal(s.signDigest(digest), s.signDigest(digest));
  s.wipe();
});

test("verify rejects the wrong signer's key", () => {
  const a = signerFor(ACCOUNT, "active", TEST_PASSPHRASE);
  const b = signerFor("bob", "active", TEST_PASSPHRASE);
  const digest = new Uint8Array(32).fill(9);
  const sig = a.signDigest(digest);
  assert.equal(verify(digest, sig, a.getAddress()), true);
  assert.equal(verify(digest, sig, b.getAddress()), false);
  a.wipe();
  b.wipe();
});

test("verify rejects a tampered digest", () => {
  const s = signerFor(ACCOUNT, "active", TEST_PASSPHRASE);
  const digest = new Uint8Array(32).fill(1);
  const sig = s.signDigest(digest);
  const other = new Uint8Array(32).fill(2);
  assert.equal(verify(other, sig, s.getAddress()), false);
  s.wipe();
});

test("verifyWithPubKey works with raw bytes and a bare compact sig", () => {
  const s = signerFor(ACCOUNT, "posting", TEST_PASSPHRASE);
  const digest = new Uint8Array(32).fill(5);
  const { signature } = s.signDigestCompact(digest);
  assert.equal(signature.length, 128); // 64 bytes compact
  assert.equal(verifyWithPubKey(digest, signature, s.publicKeyBytes()), true);
  s.wipe();
});

test("verify returns false (not throw) on malformed inputs", () => {
  const s = signerFor(ACCOUNT, "active", TEST_PASSPHRASE);
  const digest = new Uint8Array(32).fill(3);
  assert.equal(verify(digest, "0xnothex", s.getAddress()), false);
  assert.equal(verify(digest, "0xdead", s.getAddress()), false); // wrong length
  assert.equal(verify(digest, s.signDigest(digest), "WRONGPREFIX123"), false);
  s.wipe();
});

// ---------------------------------------------------------------------------
// Tier model (AK3)
// ---------------------------------------------------------------------------

test("deriveAllTiers yields four distinct keys, each matching signerFor", async () => {
  const tiers = await deriveAllTiers(ACCOUNT, TEST_PASSPHRASE, { prefix: "MELEK" });
  const seen = new Set();
  for (const role of ROLES) {
    const addr = tiers[role].getAddress();
    assert.equal(addr, EXPECT_PUBKEY[role], `tier ${role}`);
    seen.add(addr);
    const direct = signerFor(ACCOUNT, role, TEST_PASSPHRASE, { prefix: "MELEK" });
    assert.equal(direct.getAddress(), addr);
    direct.wipe();
    tiers[role].wipe();
  }
  assert.equal(seen.size, 4, "all four role keys are distinct");
});

test("derivePublicTiers returns just the public strings", async () => {
  const pubs = await derivePublicTiers(ACCOUNT, TEST_PASSPHRASE, { prefix: "MELEK" });
  assert.deepEqual(pubs, EXPECT_PUBKEY);
});

test("wrong password -> every derived key differs", () => {
  for (const role of ROLES) {
    const right = publicKeyOf(ACCOUNT, role, TEST_PASSPHRASE);
    const wrong = publicKeyOf(ACCOUNT, role, TEST_PASSPHRASE + "x");
    assert.notEqual(right, wrong, `role ${role} must change with the password`);
  }
});

test("tierForOperation maps ops to the right authority", () => {
  assert.equal(tierForOperation("transfer"), "active");
  assert.equal(tierForOperation("vote"), "posting");
  assert.equal(tierForOperation("comment"), "posting");
  assert.equal(tierForOperation("account_update"), "owner");
  assert.equal(tierForOperation("some_unknown_op"), "active"); // safe default
});

test("roleSatisfies honors owner>active>posting inheritance; memo is isolated", () => {
  assert.equal(roleSatisfies("owner", "posting"), true);
  assert.equal(roleSatisfies("active", "posting"), true);
  assert.equal(roleSatisfies("posting", "active"), false);
  assert.equal(roleSatisfies("owner", "active"), true);
  assert.equal(roleSatisfies("memo", "memo"), true);
  assert.equal(roleSatisfies("owner", "memo"), false);
  assert.equal(roleSatisfies("memo", "posting"), false);
});

test("TIER_POLICY exposes all four roles with purposes", () => {
  for (const role of ROLES) {
    assert.ok(TIER_POLICY[role], `policy for ${role}`);
    assert.equal(typeof TIER_POLICY[role].purpose, "string");
  }
});

// ---------------------------------------------------------------------------
// Signer boundary & guards
// ---------------------------------------------------------------------------

test("the private scalar never leaks through a getter; only exportWif reveals it", () => {
  const s = signerFor(ACCOUNT, "active", TEST_PASSPHRASE);
  // No enumerable/own field exposes the private key.
  const dump = JSON.stringify(s, (_k, v) =>
    v instanceof Uint8Array ? Array.from(v).join(",") : v
  );
  assert.ok(!dump.includes(EXPECT_WIF_ACTIVE));
  // The only intentional reveal:
  assert.equal(s.exportWif(), EXPECT_WIF_ACTIVE);
  s.wipe();
});

test("a wiped signer refuses to sign or expose keys", () => {
  const s = signerFor(ACCOUNT, "active", TEST_PASSPHRASE);
  s.wipe();
  assert.throws(() => s.signDigest(new Uint8Array(32)), /wiped/i);
  assert.throws(() => s.exportWif(), /wiped/i);
  assert.throws(() => s.getAddress(), /wiped/i);
});

test("input guards reject bad account/role/password", () => {
  assert.throws(() => signerFor("", "active", TEST_PASSPHRASE), /account/i);
  assert.throws(() => signerFor(ACCOUNT, "bogus", TEST_PASSPHRASE), /role/i);
  assert.throws(() => signerFor(ACCOUNT, "active", ""), /password/i);
  assert.throws(() => requireRole("nope"), /role/i);
});

test("signDigest rejects a non-32-byte digest", () => {
  const s = signerFor(ACCOUNT, "active", TEST_PASSPHRASE);
  assert.throws(() => s.signDigest(new Uint8Array(31)), /32 bytes/);
  s.wipe();
});

test("wifToPriv rejects a corrupted WIF (checksum)", () => {
  const bad = EXPECT_WIF_ACTIVE.slice(0, -1) + (EXPECT_WIF_ACTIVE.endsWith("A") ? "B" : "A");
  assert.throws(() => wifToPriv(bad), /checksum|WIF/i);
});

// ---------------------------------------------------------------------------
// Adapter swappability (AK4 seam)
// ---------------------------------------------------------------------------

test("a custom adapter is honored end-to-end", () => {
  // Wrap the default adapter to prove the seam is real (counts derive calls).
  let derives = 0;
  const wrapped = {
    ...nobleAdapter,
    derivePriv(a, r, p) {
      derives++;
      return nobleAdapter.derivePriv(a, r, p);
    },
  };
  const s = signerFor(ACCOUNT, "active", TEST_PASSPHRASE, { adapter: wrapped });
  assert.equal(derives, 1);
  assert.equal(s.getAddress(), EXPECT_PUBKEY.active);
  // verify can also take the same adapter
  const digest = new Uint8Array(32).fill(11);
  assert.equal(verify(digest, s.signDigest(digest), s.getAddress(), { adapter: wrapped }), true);
  s.wipe();
});
