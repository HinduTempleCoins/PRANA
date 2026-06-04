import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import {
  makeTokenList,
  fromDeployments,
  format,
  parse,
} from '../src/tokenlist.js';

// Lowercase addresses on purpose so we can assert checksum normalization.
// (Must contain hex letters a-f so the EIP-55 checksum actually changes the
// casing — an all-numeric address is checksum-identical to its lowercase form.)
const WPRANA = '0xabcdef0123456789abcdef0123456789abcdef01';
const USDC = '0x2222222222222222222222222222222222222222';

test('makeTokenList normalizes + checksums addresses and indexes by symbol', () => {
  const { tokens, bySymbol, byAddress } = makeTokenList([
    { address: WPRANA, symbol: 'WPRANA', decimals: 18, name: 'Wrapped PRANA' },
    { address: USDC, symbol: 'USDC', decimals: 6, name: 'USD Coin' },
  ]);

  assert.equal(tokens.length, 2);

  // Addresses are returned in EIP-55 checksummed form.
  assert.equal(tokens[0].address, getAddress(WPRANA));
  assert.notEqual(tokens[0].address, WPRANA); // checksum changed the casing

  // bySymbol index resolves to the normalized token.
  const wprana = bySymbol.get('WPRANA');
  assert.ok(wprana);
  assert.equal(wprana.symbol, 'WPRANA');
  assert.equal(wprana.decimals, 18);
  assert.equal(wprana.name, 'Wrapped PRANA');
  assert.equal(wprana.address, getAddress(WPRANA));

  // byAddress index keyed by the checksummed address.
  const usdc = byAddress.get(getAddress(USDC));
  assert.ok(usdc);
  assert.equal(usdc.symbol, 'USDC');
  assert.equal(usdc.decimals, 6);
});

test('makeTokenList throws on a bad address', () => {
  assert.throws(
    () =>
      makeTokenList([
        { address: '0xnot-an-address', symbol: 'BAD', decimals: 18, name: 'Bad' },
      ]),
    /invalid token address/,
  );
});

test('makeTokenList throws on out-of-range decimals', () => {
  assert.throws(
    () =>
      makeTokenList([
        { address: WPRANA, symbol: 'X', decimals: 37, name: 'X' },
      ]),
    /decimals/,
  );
});

test('makeTokenList throws on duplicate symbols', () => {
  assert.throws(
    () =>
      makeTokenList([
        { address: WPRANA, symbol: 'DUP', decimals: 18, name: 'One' },
        { address: USDC, symbol: 'DUP', decimals: 18, name: 'Two' },
      ]),
    /duplicate token symbol/,
  );
});

test('format/parse round-trip', () => {
  const base = parse('1.5', 18);
  assert.equal(base, 1500000000000000000n);
  assert.equal(format(base, 18), '1.5');

  // 6-decimal token round-trips too.
  assert.equal(format(parse('1234.56', 6), 6), '1234.56');
});

test('fromDeployments builds entries from a deployments.json-style map', () => {
  const deployments = {
    contracts: {
      WPRANA: WPRANA,
      USDC: USDC,
    },
  };

  const { tokens, bySymbol } = fromDeployments(deployments);

  assert.equal(tokens.length, 2);

  const wprana = bySymbol.get('WPRANA');
  assert.ok(wprana);
  assert.equal(wprana.symbol, 'WPRANA');
  assert.equal(wprana.name, 'WPRANA'); // name defaults to the contract Name
  assert.equal(wprana.decimals, 18); // default decimals
  assert.equal(wprana.address, getAddress(WPRANA)); // checksummed

  assert.ok(bySymbol.get('USDC'));
});
