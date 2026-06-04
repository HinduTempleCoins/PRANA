// akasha/test/keystore.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { Keystore } from "../lib/keystore.mjs";
import { createMemoryStorage, createFsStorage } from "../lib/storage-fs.mjs";

const FAST = { N: 1 << 10, r: 8, p: 1 };

const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";
const TEST_ADDR_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// anvil account #0 private key (publicly known dev key — fine for tests).
const TEST_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Fake clock that lets tests drive auto-lock deterministically.
function makeFakeClock() {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map(); // id -> { at, fn }
  return {
    clock: {
      now: () => nowMs,
      setTimeout: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { at: nowMs + ms, fn });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
    },
    advance(ms) {
      nowMs += ms;
      for (const [id, t] of [...timers.entries()]) {
        if (t.at <= nowMs) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

test("add HD vault + imported key, list and get round-trip", async () => {
  const ks = new Keystore({ storage: createMemoryStorage(), scrypt: FAST });
  await ks.unlock("masterpw");

  const vid = await ks.addVault({ mnemonic: TEST_MNEMONIC, label: "Main" });
  const kid = await ks.addImportedKey(TEST_PK, { label: "Anvil0" });

  const listed = ks.list();
  assert.equal(listed.length, 2);
  assert.equal(listed.find((e) => e.id === vid).type, "vault");
  assert.equal(listed.find((e) => e.id === kid).type, "imported");

  const vault = await ks.get(vid);
  assert.equal(vault.mnemonic, TEST_MNEMONIC);
  assert.equal(vault.signerFor(0).address, TEST_ADDR_0);

  const imported = await ks.get(kid);
  assert.equal(imported.address, TEST_ADDR_0); // anvil0 pk == m/44'/60'/0'/0/0
  assert.equal(imported.privateKey.toLowerCase(), TEST_PK.toLowerCase());
});

test("persistence: save then reload from a fresh Keystore", async () => {
  const storage = createMemoryStorage();
  const ks1 = new Keystore({ storage, scrypt: FAST });
  await ks1.unlock("pw");
  const id = await ks1.addImportedKey(TEST_PK);

  const ks2 = new Keystore({ storage, scrypt: FAST });
  await ks2.load();
  await ks2.unlock("pw");
  assert.equal(ks2.list().length, 1);
  const got = await ks2.get(id);
  assert.equal(got.address, TEST_ADDR_0);
});

test("wrong password fails to unlock a populated store", async () => {
  const storage = createMemoryStorage();
  const ks1 = new Keystore({ storage, scrypt: FAST });
  await ks1.unlock("correct");
  await ks1.addImportedKey(TEST_PK);

  const ks2 = new Keystore({ storage, scrypt: FAST });
  await ks2.load();
  await assert.rejects(() => ks2.unlock("incorrect"), /incorrect password/i);
});

test("remove deletes an entry", async () => {
  const ks = new Keystore({ storage: createMemoryStorage(), scrypt: FAST });
  await ks.unlock("pw");
  const id = await ks.addImportedKey(TEST_PK);
  assert.equal(ks.list().length, 1);
  await ks.remove(id);
  assert.equal(ks.list().length, 0);
  await assert.rejects(() => ks.get(id), /no entry/i);
});

test("changePassword re-encrypts all entries; old password stops working", async () => {
  const storage = createMemoryStorage();
  const ks = new Keystore({ storage, scrypt: FAST });
  await ks.unlock("oldpw");
  await ks.addVault({ mnemonic: TEST_MNEMONIC });
  await ks.addImportedKey(TEST_PK);

  await ks.changePassword("oldpw", "newpw");

  // A fresh store loaded from disk must open with the NEW password only.
  const fresh = new Keystore({ storage, scrypt: FAST });
  await fresh.load();
  await assert.rejects(() => fresh.unlock("oldpw"), /incorrect password/i);
  await fresh.unlock("newpw");
  assert.equal(fresh.list().length, 2);
  // Secrets survive the re-encryption intact.
  const v = await fresh.get(fresh.list().find((e) => e.type === "vault").id);
  assert.equal(v.mnemonic, TEST_MNEMONIC);
});

test("changePassword with wrong old password rejects", async () => {
  const ks = new Keystore({ storage: createMemoryStorage(), scrypt: FAST });
  await ks.unlock("realpw");
  await ks.addImportedKey(TEST_PK);
  // Session is unlocked with realpw; passing a different old password is rejected.
  await assert.rejects(() => ks.changePassword("guesspw", "newpw"), /does not match/i);
});

test("auto-lock fires after the idle timeout (fake clock)", async () => {
  const { clock, advance } = makeFakeClock();
  const ks = new Keystore({
    storage: createMemoryStorage(),
    scrypt: FAST,
    clock,
    autoLockMs: 1000,
  });
  await ks.unlock("pw");
  assert.equal(ks.locked, false);

  advance(500);
  assert.equal(ks.locked, false); // not yet

  advance(600); // total 1100 > 1000
  assert.equal(ks.locked, true);

  // Operations after auto-lock must fail until re-unlock.
  await assert.rejects(() => ks.addImportedKey(TEST_PK), /locked/i);
});

test("activity resets the auto-lock timer", async () => {
  const { clock, advance } = makeFakeClock();
  const ks = new Keystore({
    storage: createMemoryStorage(),
    scrypt: FAST,
    clock,
    autoLockMs: 1000,
  });
  await ks.unlock("pw");
  advance(800);
  await ks.addImportedKey(TEST_PK); // _touch() re-arms the timer
  advance(800); // 800 since last activity, still < 1000
  assert.equal(ks.locked, false);
  advance(300); // now 1100 since last activity
  assert.equal(ks.locked, true);
});

test("fs storage impl persists to disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "akasha-ks-"));
  const file = join(dir, "store.json");
  try {
    const ks = new Keystore({ storage: createFsStorage(file), scrypt: FAST });
    await ks.unlock("pw");
    await ks.addImportedKey(TEST_PK);

    const raw = await readFile(file, "utf8");
    assert.ok(raw.includes('"version"'));
    // The plaintext private key must NOT appear on disk.
    assert.ok(!raw.includes(TEST_PK.slice(2)));

    const ks2 = new Keystore({ storage: createFsStorage(file), scrypt: FAST });
    await ks2.load();
    await ks2.unlock("pw");
    assert.equal(ks2.list().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
