// Mainnet config + token-unit helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_ID, CHAIN_ID_HEX, RPC_URL, TOKENS, isPublicTestAddress, kulaSwapLink } from '../src/lib/network.js';
import { formatUnits, parseUnits } from '../src/lib/format.js';

test('pinned to PRANA mainnet, never the retired alpha chain', () => {
  assert.equal(CHAIN_ID, 712217);
  assert.equal(BigInt(CHAIN_ID_HEX), 712217n);
  assert.match(RPC_URL, /^https:\/\//);
  assert.ok(!RPC_URL.includes('alpha'));
});

test('token list decimals', () => {
  const d = Object.fromEntries(TOKENS.map((t) => [t.symbol, t.decimals]));
  assert.deepEqual(d, { KULA: 18, WPRANA: 18, wVKBT: 8, wCURE: 8, wMELEK: 18 });
  for (const t of TOKENS) assert.match(t.address, /^0x[0-9a-fA-F]{40}$/);
});

test('public dev keys are flagged (any case)', () => {
  assert.ok(isPublicTestAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'));
  assert.ok(!isPublicTestAddress('0x026d69cB54B82a805b6aaE60718C4877124D8d11'));
});

test('kulaswap link carries ?in=&out=', () => {
  assert.equal(kulaSwapLink('wVKBT', 'WPRANA'), 'https://kula.money/?in=wVKBT&out=WPRANA');
});

test('formatUnits / parseUnits round-trip at 8 and 18 decimals', () => {
  assert.equal(formatUnits(158331693375n, 8, 4), '1583.3169');
  assert.equal(parseUnits('1583.31693375', 8), 158331693375n);
  assert.equal(parseUnits('1.5', 18), 1500000000000000000n);
  assert.throws(() => parseUnits('1.123456789', 8));
  assert.throws(() => parseUnits('abc', 8));
});
