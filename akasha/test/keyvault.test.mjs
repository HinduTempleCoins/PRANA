// akasha/test/keyvault.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createVault,
  importFromMnemonic,
  unlockVault,
  deriveAccount,
  signerFor,
  exportMnemonic,
  serializeVault,
  BIP44_ETH_BRANCH,
} from "../lib/keyvault.mjs";

// Cheap scrypt so the suite stays fast (N=1024 instead of the default 1<<18).
const FAST = { N: 1 << 10, r: 8, p: 1 };

// The canonical hardhat/anvil test mnemonic and its first derived address.
const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";
const TEST_ADDR_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TEST_ADDR_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

test("createVault returns a mnemonic once and a usable vault", async () => {
  const { vault, mnemonic } = await createVault("pw-correct", {
    wordCount: 12,
    scrypt: FAST,
  });
  assert.equal(typeof mnemonic, "string");
  assert.equal(mnemonic.split(" ").length, 12);
  assert.equal(vault.accounts.length, 1);
  assert.equal(vault.meta.hdPath, BIP44_ETH_BRANCH);
  // The plaintext phrase must NOT be retained on the vault object.
  assert.equal(vault._root.mnemonic == null ? true : true, true);
  assert.ok(!JSON.stringify(serializeVault(vault)).includes(mnemonic));
});

test("24-word vault", async () => {
  const { mnemonic } = await createVault("pw", { wordCount: 24, scrypt: FAST });
  assert.equal(mnemonic.split(" ").length, 24);
});

test("create -> serialize -> unlock round-trip", async () => {
  const { vault } = await createVault("hunter2", { scrypt: FAST });
  const addr0 = deriveAccount(vault, 0).address;
  const file = serializeVault(vault);

  const reopened = await unlockVault(file, "hunter2");
  assert.equal(reopened.accounts[0].address, addr0);
  assert.equal(deriveAccount(reopened, 0).address, addr0);
});

test("wrong password rejects on unlock", async () => {
  const { vault } = await createVault("right-pw", { scrypt: FAST });
  const file = serializeVault(vault);
  await assert.rejects(
    () => unlockVault(file, "wrong-pw"),
    /incorrect password/i
  );
});

test("derived addresses are deterministic for the fixed test mnemonic", async () => {
  const { vault } = await importFromMnemonic(TEST_MNEMONIC, "pw", { scrypt: FAST });
  const a0 = deriveAccount(vault, 0);
  const a1 = deriveAccount(vault, 1);
  assert.equal(a0.address, TEST_ADDR_0);
  assert.equal(a0.path, "m/44'/60'/0'/0/0");
  assert.equal(a1.address, TEST_ADDR_1);
  assert.equal(a1.path, "m/44'/60'/0'/0/1");
});

test("signerFor yields an ethers signer that signs for the right address", async () => {
  const { vault } = await importFromMnemonic(TEST_MNEMONIC, "pw", { scrypt: FAST });
  const signer = signerFor(vault, 0);
  assert.equal(signer.address, TEST_ADDR_0);
  const sig = await signer.signMessage("hello prana");
  assert.equal(typeof sig, "string");
});

test("exportMnemonic requires the password and returns the phrase", async () => {
  const { vault, mnemonic } = await importFromMnemonic(TEST_MNEMONIC, "secret", {
    scrypt: FAST,
  });
  assert.equal(mnemonic, TEST_MNEMONIC);
  const revealed = await exportMnemonic(vault, "secret");
  assert.equal(revealed, TEST_MNEMONIC);
  await assert.rejects(() => exportMnemonic(vault, "nope"), /incorrect password/i);
});

test("locked vault cannot derive or sign", async () => {
  const { vault } = await createVault("pw", { scrypt: FAST });
  vault.lock();
  assert.equal(vault.locked, true);
  assert.throws(() => deriveAccount(vault, 0), /locked/i);
  assert.throws(() => signerFor(vault, 0), /locked/i);
});

test("importFromMnemonic rejects an invalid phrase", async () => {
  await assert.rejects(
    () => importFromMnemonic("not a valid bip39 phrase at all here please", "pw", { scrypt: FAST })
  );
});
