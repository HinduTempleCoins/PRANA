// SPDX-License-Identifier: MIT
/**
 * Tests for the SIWE (EIP-4361) module — pure node:test, no hardhat.
 *
 * Run with:  node --test tools/siwe/
 *
 * `ethers` resolves as a bare specifier because node walks up to
 * contracts/node_modules (this file lives at contracts/tools/siwe/).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";

import {
  buildMessage,
  parseMessage,
  verify,
  generateNonce,
} from "./siwe.mjs";

const BASE = {
  domain: "rooms.prana.example",
  address: "0x2e988A386a799F506693793c6A5AF6B54dfAaBfB",
  statement: "Sign in to access the token-gated room.",
  uri: "https://rooms.prana.example/login",
  version: "1",
  chainId: 108369,
  nonce: "abcd1234efgh5678",
  issuedAt: "2026-06-03T12:00:00.000Z",
};

test("generateNonce produces alphanumeric strings of the requested length", () => {
  const n = generateNonce();
  assert.equal(n.length, 16);
  assert.match(n, /^[A-Za-z0-9]+$/);
  const n2 = generateNonce(24);
  assert.equal(n2.length, 24);
  assert.notEqual(n, n2);
  assert.throws(() => generateNonce(4), />= 8/);
});

test("buildMessage produces the exact EIP-4361 ABNF string", () => {
  const msg = buildMessage(BASE);
  const expected = [
    "rooms.prana.example wants you to sign in with your Ethereum account:",
    "0x2e988A386a799F506693793c6A5AF6B54dfAaBfB",
    "",
    "Sign in to access the token-gated room.",
    "",
    "URI: https://rooms.prana.example/login",
    "Version: 1",
    "Chain ID: 108369",
    "Nonce: abcd1234efgh5678",
    "Issued At: 2026-06-03T12:00:00.000Z",
  ].join("\n");
  assert.equal(msg, expected);
});

test("build/parse round-trips with all optional fields", () => {
  const fields = {
    ...BASE,
    expirationTime: "2026-06-03T13:00:00.000Z",
    notBefore: "2026-06-03T11:30:00.000Z",
    requestId: "req-42",
    resources: [
      "https://rooms.prana.example/room/general",
      "ipfs://bafyfoo",
    ],
  };
  const msg = buildMessage(fields);
  const parsed = parseMessage(msg);
  assert.deepEqual(parsed, {
    domain: fields.domain,
    address: fields.address,
    statement: fields.statement,
    uri: fields.uri,
    version: fields.version,
    chainId: String(fields.chainId), // chainId comes back as a string
    nonce: fields.nonce,
    issuedAt: fields.issuedAt,
    expirationTime: fields.expirationTime,
    notBefore: fields.notBefore,
    requestId: fields.requestId,
    resources: fields.resources,
  });
});

test("build/parse round-trips without a statement", () => {
  const { statement, ...noStmt } = BASE;
  const msg = buildMessage(noStmt);
  const parsed = parseMessage(msg);
  assert.equal(parsed.statement, undefined);
  assert.equal(parsed.domain, BASE.domain);
  assert.equal(parsed.uri, BASE.uri);
  assert.equal(parsed.nonce, BASE.nonce);
});

test("verify accepts a genuine wallet signature", async () => {
  const wallet = Wallet.createRandom();
  const fields = { ...BASE, address: wallet.address };
  const message = buildMessage(fields);
  const signature = await wallet.signMessage(message);

  const res = verify({ message, signature, now: Date.parse(BASE.issuedAt) });
  assert.equal(res.success, true, res.error);
  assert.equal(res.recovered, wallet.address);
  assert.equal(res.fields.nonce, BASE.nonce);
});

test("verify rejects a signature from a different key (tampered address)", async () => {
  const signer = Wallet.createRandom();
  const other = Wallet.createRandom();
  // Build a message claiming `other`'s address, but sign with `signer`.
  const fields = { ...BASE, address: other.address };
  const message = buildMessage(fields);
  const signature = await signer.signMessage(message);

  const res = verify({ message, signature, now: Date.parse(BASE.issuedAt) });
  assert.equal(res.success, false);
  assert.match(res.error, /does not match/);
});

test("verify rejects when a field is tampered after signing", async () => {
  const wallet = Wallet.createRandom();
  const fields = { ...BASE, address: wallet.address };
  const message = buildMessage(fields);
  const signature = await wallet.signMessage(message);

  // Flip the nonce in the signed bytes — signature no longer recovers the signer.
  const tampered = message.replace(
    "Nonce: abcd1234efgh5678",
    "Nonce: zzzz0000zzzz0000"
  );
  const res = verify({ message: tampered, signature, now: Date.parse(BASE.issuedAt) });
  assert.equal(res.success, false);
  assert.match(res.error, /does not match/);
});

test("verify rejects an expired message", async () => {
  const wallet = Wallet.createRandom();
  const fields = {
    ...BASE,
    address: wallet.address,
    expirationTime: "2026-06-03T13:00:00.000Z",
  };
  const message = buildMessage(fields);
  const signature = await wallet.signMessage(message);

  // now == 1 hour after expiry
  const res = verify({
    message,
    signature,
    now: Date.parse("2026-06-03T14:00:00.000Z"),
  });
  assert.equal(res.success, false);
  assert.match(res.error, /expired/);
});

test("verify rejects a not-yet-valid message (Not Before)", async () => {
  const wallet = Wallet.createRandom();
  const fields = {
    ...BASE,
    address: wallet.address,
    notBefore: "2026-06-03T11:30:00.000Z",
  };
  const message = buildMessage(fields);
  const signature = await wallet.signMessage(message);

  const res = verify({
    message,
    signature,
    now: Date.parse("2026-06-03T11:00:00.000Z"),
  });
  assert.equal(res.success, false);
  assert.match(res.error, /not yet valid/);
});

test("verify enforces expectedNonce / expectedDomain when provided", async () => {
  const wallet = Wallet.createRandom();
  const fields = { ...BASE, address: wallet.address };
  const message = buildMessage(fields);
  const signature = await wallet.signMessage(message);
  const at = { now: Date.parse(BASE.issuedAt) };

  assert.equal(
    verify({ message, signature, ...at, expectedNonce: "wrong-nonce" }).success,
    false
  );
  assert.equal(
    verify({ message, signature, ...at, expectedDomain: "evil.example" }).success,
    false
  );
  assert.equal(
    verify({
      message,
      signature,
      ...at,
      expectedNonce: BASE.nonce,
      expectedDomain: BASE.domain,
    }).success,
    true
  );
});

test("parseMessage throws on a malformed preamble", () => {
  assert.throws(() => parseMessage("not a siwe message"), /bad preamble/);
});
