// Tests for bridge-initiate.mjs — builds deposit/withdraw against the REAL bridge ABIs,
// decodes the withdrawal event, rejects bad params. No live node; unref'd timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWithdraw,
  buildDeposit,
  ingestReceipt,
  watchCompletion,
  encodeEvmRecipient,
  canonicalIface,
  grapheneIface,
  ROUTES,
  DIRECTIONS,
  STATUS,
} from './bridge-initiate.mjs';

const BRIDGE = '0x1111111111111111111111111111111111111111';
const WRAPPED = '0x2222222222222222222222222222222222222222';
const RECIP = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const TOKEN_ID = '0x' + 'ab'.repeat(32);
const DEST_REF = '0x' + 'cd'.repeat(32);
const PRANA = 108369;
const DST_EVM = 1;

// --- EVM withdraw -------------------------------------------------------------------------

test('EVM withdraw: encodes burn(amount,dstChainId,dstAddr) + approval, against the real ABI', async () => {
  const { handle, txRequest, approval } = await buildWithdraw({
    route: ROUTES.EVM,
    bridge: BRIDGE,
    token: WRAPPED,
    amount: 1000n,
    recipient: RECIP,
    dstChainId: DST_EVM,
    srcChainId: PRANA,
  });

  assert.equal(handle.route, ROUTES.EVM);
  assert.equal(handle.direction, DIRECTIONS.WITHDRAW);
  assert.equal(handle.status, STATUS.BUILT);
  assert.equal(txRequest.to, BRIDGE);

  // Decode with the real interface to prove the calldata is genuine.
  const decoded = canonicalIface.decodeFunctionData('burn', txRequest.data);
  assert.equal(decoded.amount, 1000n);
  assert.equal(Number(decoded.dstChainId), DST_EVM);
  assert.equal(decoded.dstAddr, encodeEvmRecipient(RECIP));

  // Approval step present and points at the wrapped token.
  assert.ok(approval.needed);
  assert.equal(approval.token.toLowerCase(), WRAPPED.toLowerCase());
});

// --- Graphene withdraw --------------------------------------------------------------------

test('Graphene withdraw: encodes withdraw(tokenId,amount,destinationRef) against the real ABI', async () => {
  const { handle, txRequest, approval } = await buildWithdraw({
    route: ROUTES.GRAPHENE,
    bridge: BRIDGE,
    token: TOKEN_ID,
    amount: 5n,
    recipient: DEST_REF,
    wrapped: WRAPPED,
  });
  assert.equal(handle.route, ROUTES.GRAPHENE);
  const decoded = grapheneIface.decodeFunctionData('withdraw', txRequest.data);
  assert.equal(decoded.tokenId, TOKEN_ID);
  assert.equal(decoded.amount, 5n);
  assert.equal(decoded.destinationRef, DEST_REF);
  assert.ok(approval.needed);
});

// --- EVM deposit (== source-chain burn) ---------------------------------------------------

test('EVM deposit: builds source-chain burn marked as a deposit', async () => {
  const { handle, txRequest } = await buildDeposit({
    route: ROUTES.EVM,
    bridge: BRIDGE,
    token: WRAPPED,
    amount: 42n,
    recipient: RECIP,
    dstChainId: PRANA,
    srcChainId: DST_EVM,
  });
  assert.equal(handle.direction, DIRECTIONS.DEPOSIT);
  const decoded = canonicalIface.decodeFunctionData('burn', txRequest.data);
  assert.equal(decoded.amount, 42n);
});

// --- Graphene deposit (watch-only, no EVM tx) ---------------------------------------------

test('Graphene deposit: no EVM tx, returns a nativeSend instruction', async () => {
  const { handle, txRequest, nativeSend } = await buildDeposit({
    route: ROUTES.GRAPHENE,
    token: TOKEN_ID,
    amount: 7n,
    recipient: RECIP,
    dstChainId: PRANA,
  });
  assert.equal(txRequest, null);
  assert.equal(handle.direction, DIRECTIONS.DEPOSIT);
  assert.equal(nativeSend.chain, 'graphene');
  assert.equal(nativeSend.tokenId, TOKEN_ID);
  assert.equal(nativeSend.amount, 7n);
});

// --- receipt decode -----------------------------------------------------------------------

test('ingestReceipt decodes the Withdrawal event and folds the nonce in', async () => {
  const { handle } = await buildWithdraw({
    route: ROUTES.EVM,
    bridge: BRIDGE,
    token: WRAPPED,
    amount: 1000n,
    recipient: RECIP,
    dstChainId: DST_EVM,
    srcChainId: PRANA,
  });

  // Build a real Withdrawal log via the interface, then feed it through ingestReceipt.
  const log = canonicalIface.encodeEventLog('Withdrawal', [
    99n, // withdrawalNonce
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // from
    DST_EVM,
    encodeEvmRecipient(RECIP),
    1000n,
  ]);
  const receipt = { hash: '0xdeadbeef', logs: [{ topics: log.topics, data: log.data }] };

  ingestReceipt(handle, receipt);
  assert.equal(handle.nonce, 99n);
  assert.equal(handle.srcTxHash, '0xdeadbeef');
  assert.equal(handle.status, STATUS.INITIATED);
});

test('ingestReceipt decodes GrapheneWithdrawal nonce', async () => {
  const { handle } = await buildWithdraw({
    route: ROUTES.GRAPHENE,
    bridge: BRIDGE,
    token: TOKEN_ID,
    amount: 5n,
    recipient: DEST_REF,
    wrapped: WRAPPED,
  });
  const log = grapheneIface.encodeEventLog('GrapheneWithdrawal', [
    7n, // nonce
    TOKEN_ID,
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    WRAPPED,
    5n,
    DEST_REF,
  ]);
  ingestReceipt(handle, { hash: '0xabc', logs: [{ topics: log.topics, data: log.data }] });
  assert.equal(handle.nonce, 7n);
  assert.equal(handle.status, STATUS.INITIATED);
});

// --- watchCompletion stub (fixture mode) --------------------------------------------------

test('watchCompletion in fixture mode (no provider) sets status to completing and returns', async () => {
  const { handle } = await buildWithdraw({
    route: ROUTES.EVM,
    bridge: BRIDGE,
    token: WRAPPED,
    amount: 1n,
    recipient: RECIP,
    dstChainId: DST_EVM,
    srcChainId: PRANA,
  });
  const out = await watchCompletion(handle, {});
  assert.equal(out.status, STATUS.COMPLETING);
});

test('watchCompletion finds a Minted log via a mock destination contract', async () => {
  const { handle } = await buildWithdraw({
    route: ROUTES.EVM,
    bridge: BRIDGE,
    token: WRAPPED,
    amount: 1n,
    recipient: RECIP,
    dstChainId: DST_EVM,
    srcChainId: PRANA,
  });
  handle.nonce = 99n;

  const mockContract = {
    filters: { Minted: () => ({ topics: ['0xminted'] }) },
    async queryFilter() {
      return [{ transactionHash: '0xfeed', blockNumber: 5 }];
    },
  };
  const out = await watchCompletion(handle, { dstContract: mockContract, timeoutMs: 1000, pollMs: 1 });
  assert.equal(out.status, STATUS.COMPLETED);
  assert.equal(out.completionEvent.name, 'Minted');
  assert.equal(out.completionEvent.txHash, '0xfeed');
});

test('watchCompletion times out (no matching log) with unref timers', async () => {
  const { handle } = await buildWithdraw({
    route: ROUTES.EVM,
    bridge: BRIDGE,
    token: WRAPPED,
    amount: 1n,
    recipient: RECIP,
    dstChainId: DST_EVM,
    srcChainId: PRANA,
  });
  const mockContract = {
    filters: { Minted: () => ({ topics: ['0xminted'] }) },
    async queryFilter() {
      return [];
    },
  };
  const out = await watchCompletion(handle, { dstContract: mockContract, timeoutMs: 5, pollMs: 1 });
  assert.equal(out.status, STATUS.TIMEOUT);
});

// --- param rejection ----------------------------------------------------------------------

test('rejects unknown route', async () => {
  await assert.rejects(() => buildWithdraw({ route: 'btc', bridge: BRIDGE, amount: 1n }), /unknown route/);
});

test('rejects zero/negative amount', async () => {
  await assert.rejects(
    () => buildWithdraw({ route: ROUTES.EVM, bridge: BRIDGE, token: WRAPPED, amount: 0n, recipient: RECIP, dstChainId: 1 }),
    /amount must be > 0/,
  );
});

test('rejects bad EVM recipient', async () => {
  await assert.rejects(
    () => buildWithdraw({ route: ROUTES.EVM, bridge: BRIDGE, token: WRAPPED, amount: 1n, recipient: '0x1234', dstChainId: 1 }),
    /invalid EVM recipient/,
  );
});

test('rejects missing dstChainId on EVM route', async () => {
  await assert.rejects(
    () => buildWithdraw({ route: ROUTES.EVM, bridge: BRIDGE, token: WRAPPED, amount: 1n, recipient: RECIP }),
    /dstChainId is required/,
  );
});

test('rejects bad bridge address', async () => {
  await assert.rejects(
    () => buildWithdraw({ route: ROUTES.EVM, bridge: '0xnope', token: WRAPPED, amount: 1n, recipient: RECIP, dstChainId: 1 }),
    /bridge address/,
  );
});

test('rejects non-bytes32 tokenId on graphene route', async () => {
  await assert.rejects(
    () => buildWithdraw({ route: ROUTES.GRAPHENE, bridge: BRIDGE, token: '0x1234', amount: 1n, recipient: DEST_REF, wrapped: WRAPPED }),
    /tokenId must be a 32-byte/,
  );
});

test('rejects bad PRANA recipient on deposit', async () => {
  await assert.rejects(
    () => buildDeposit({ route: ROUTES.GRAPHENE, token: TOKEN_ID, amount: 1n, recipient: '0xbad' }),
    /valid PRANA address/,
  );
});
