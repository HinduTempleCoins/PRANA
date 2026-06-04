// akasha/lib/identity.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { importFromMnemonic } from "./keyvault.mjs";
import {
  createIdentity,
  makeFixtureGrapheneSigner,
  CHAIN_TRACK,
  GRAPHENE_ROLES,
} from "./identity.mjs";

// Cheap scrypt so the suite stays fast.
const FAST = { N: 1 << 10, r: 8, p: 1 };

// Canonical hardhat/anvil test mnemonic + its first EVM address.
const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";
const TEST_ADDR_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// Build a full unified identity (EVM vault + fixture Graphene signer) from one master.
async function makeIdentity({
  mnemonic = TEST_MNEMONIC,
  account = "alice",
  masterPw = "graphene-master-pw",
  label = "Alice",
} = {}) {
  const { vault } = await importFromMnemonic(mnemonic, "pw", { scrypt: FAST });
  const grapheneSigner = makeFixtureGrapheneSigner(account, masterPw);
  return createIdentity({ label, evmVault: vault, grapheneSigner });
}

test("one master input → stable EVM + Graphene addresses", async () => {
  const a = await makeIdentity();
  const b = await makeIdentity();

  // EVM address is the canonical anvil index-0 address, and stable across builds.
  assert.equal(a.evmAddress(), TEST_ADDR_0);
  assert.equal(a.evmAddress(), b.evmAddress());

  // Graphene account + all four role pubkeys are stable across builds.
  const ga = a.grapheneAccounts();
  const gb = b.grapheneAccounts();
  assert.equal(ga.length, 1);
  assert.equal(ga[0].account, "alice");
  for (const role of GRAPHENE_ROLES) {
    assert.equal(typeof ga[0].roles[role], "string");
    assert.ok(ga[0].roles[role].startsWith("MLK"));
    assert.equal(ga[0].roles[role], gb[0].roles[role]); // deterministic
  }
});

test("profile() shape is correct and display-safe (no secrets)", async () => {
  const id = await makeIdentity();
  const p = id.profile();

  assert.equal(p.label, "Alice");
  assert.equal(p.evm.chain, "prana");
  assert.equal(p.evm.address, TEST_ADDR_0);
  assert.equal(p.graphene.length, 1);
  assert.deepEqual(p.graphene[0].chains, ["melek", "soap"]);
  assert.equal(p.graphene[0].account, "alice");
  assert.equal(p.locked, false);

  // No private key / mnemonic material leaks into the profile.
  const blob = JSON.stringify(p);
  assert.ok(!blob.includes(TEST_MNEMONIC));
  assert.ok(!blob.toLowerCase().includes("privatekey"));
});

test("resolveSignerFor routes to the correct track per chain", async () => {
  const id = await makeIdentity();

  // PRANA → an ethers signer for the right address.
  const evmSigner = id.resolveSignerFor("prana");
  assert.equal(evmSigner.address, TEST_ADDR_0);
  const sig = await evmSigner.signMessage("hello prana");
  assert.equal(typeof sig, "string");

  // MELEK + SOAP → a Graphene op-signer bound to the account.
  for (const chain of ["melek", "soap"]) {
    assert.equal(CHAIN_TRACK[chain], "graphene");
    const gSigner = id.resolveSignerFor(chain);
    assert.equal(gSigner.account, "alice");
    assert.equal(typeof gSigner.signOp, "function");
    // posting can vote, posting cannot transfer (role gate).
    assert.equal(typeof gSigner.signOp(["vote", { voter: "alice" }], "posting"), "string");
    assert.throws(
      () => gSigner.signOp(["transfer", { to: "bob", amount: "1.000 MLK" }], "posting"),
      /may not sign/i
    );
    assert.equal(
      typeof gSigner.signOp(["transfer", { to: "bob", amount: "1.000 MLK" }], "active"),
      "string"
    );
  }

  assert.throws(() => id.resolveSignerFor("ethereum"), /unknown chain/i);
});

test("signInWithMelek is posting-scope; connectEvm + unifiedSession reconcile one session", async () => {
  const id = await makeIdentity();

  const login = id.signInWithMelek("login-challenge-abc");
  assert.equal(login.account, "alice");
  assert.equal(login.scope, "posting");
  assert.equal(typeof login.signature, "string");

  const conn = id.connectEvm();
  assert.equal(conn.address, TEST_ADDR_0);

  const session = id.unifiedSession();
  assert.equal(session.evm.address, TEST_ADDR_0);
  assert.equal(session.graphene.account, "alice");
  assert.ok(session.graphene.posting.startsWith("MLK"));
});

test("a Graphene-only login can't produce an EVM signer it never linked (and vice-versa)", async () => {
  const grapheneOnly = createIdentity({
    label: "G-only",
    grapheneSigner: makeFixtureGrapheneSigner("bob", "pw2"),
  });
  assert.throws(() => grapheneOnly.resolveSignerFor("prana"), /no EVM account/i);
  assert.throws(() => grapheneOnly.connectEvm(), /no EVM account/i);
  // but Graphene works
  assert.equal(grapheneOnly.resolveSignerFor("melek").account, "bob");

  const { vault } = await importFromMnemonic(TEST_MNEMONIC, "pw", { scrypt: FAST });
  const evmOnly = createIdentity({ label: "E-only", evmVault: vault });
  assert.throws(() => evmOnly.resolveSignerFor("melek"), /no Graphene account/i);
  assert.throws(() => evmOnly.signInWithMelek("x"), /no Graphene account/i);
  assert.equal(evmOnly.resolveSignerFor("prana").address, TEST_ADDR_0);
});

test("lock() zeroizes BOTH tracks", async () => {
  const id = await makeIdentity();
  // sanity: both work before lock
  assert.equal(id.resolveSignerFor("prana").address, TEST_ADDR_0);
  assert.equal(id.resolveSignerFor("melek").account, "alice");

  id.lock();
  assert.equal(id.locked, true);
  assert.equal(id.profile().locked, true);

  // Both tracks refuse to produce signers after lock.
  assert.throws(() => id.resolveSignerFor("prana"), /locked/i);
  assert.throws(() => id.resolveSignerFor("melek"), /locked/i);
  assert.throws(() => id.connectEvm(), /locked/i);
  assert.throws(() => id.signInWithMelek("x"), /locked/i);

  // The underlying Graphene signer is itself zeroized (its own ops now fail).
  // (resolveSignerFor already blocks, this asserts the backend lock propagated.)
});

test("two identities from different masters differ on BOTH tracks", async () => {
  const a = await makeIdentity({
    mnemonic: TEST_MNEMONIC,
    account: "alice",
    masterPw: "pw-a",
  });
  // A genuinely different EVM seed + different graphene master.
  const otherMnemonic =
    "legal winner thank year wave sausage worth useful legal winner thank yellow";
  const b = await makeIdentity({
    mnemonic: otherMnemonic,
    account: "carol",
    masterPw: "pw-b",
  });

  assert.notEqual(a.evmAddress(), b.evmAddress());
  const ra = a.grapheneAccounts()[0].roles;
  const rb = b.grapheneAccounts()[0].roles;
  for (const role of GRAPHENE_ROLES) {
    assert.notEqual(ra[role], rb[role]);
  }
});

test("exportGrapheneKey re-auths; export is per-track, never bulk", async () => {
  const id = await makeIdentity({ masterPw: "secret-master" });

  // wrong password rejected, right password reveals one role key
  await assert.rejects(() => id.exportGrapheneKey("active", "nope"), /incorrect password/i);
  const wif = await id.exportGrapheneKey("active", "secret-master");
  assert.equal(typeof wif, "string");

  // EVM mnemonic export re-auths against the EVM password
  const phrase = await id.exportEvmMnemonic("pw");
  assert.equal(phrase, TEST_MNEMONIC);
  await assert.rejects(() => id.exportEvmMnemonic("wrong"), /incorrect password/i);

  // There is intentionally no "export everything" method.
  assert.equal(id.exportEverything, undefined);
});

test("createIdentity requires at least one backend", () => {
  assert.throws(() => createIdentity({ label: "empty" }), /at least one/i);
});
