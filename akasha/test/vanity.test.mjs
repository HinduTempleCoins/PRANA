// Tests for tools/vanity.mjs — split-key vanity derivation (no chain).
//
// We verify the two security-critical properties from design/research/G22-profanity-vanity.md:
//   (1) address(S + d·G) computed from PUBLIC material == address((s + d)·G) from the combined
//       private key — i.e. the split-key math is sound.
//   (2) the search step never needs (and the public outputs never expose) the full private key;
//       the searcher operates only on the public point S and the public child scalar d.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAddress } from 'ethers';

import {
  makeUserKey,
  addressForChild,
  combineKeys,
  matches,
  searchChild,
  generateVanity,
} from '../tools/vanity.mjs';

test('split-key: public-point address == combined-private-key address', () => {
  const { secretScalar, publicPoint } = makeUserKey();
  // Pick an arbitrary child scalar (the searcher's `d`).
  const dHex = '0x' + (123456789n).toString(16).padStart(64, '0');

  // (1) address derived from ONLY the public point + public d
  const pub = addressForChild(publicPoint, dHex);

  // (2) address derived from the actual combined private key p = s + d
  const { privateKey, address } = combineKeys(secretScalar, dHex, pub);

  assert.equal(address, pub, 'combined-key address must equal point-derived address');
  // sanity: the private key really does derive that address
  assert.equal(computeAddress(privateKey), pub);
});

test('the search step never exposes the full private key', () => {
  const { secretScalar, publicPoint } = makeUserKey();

  // A deterministic "rng" so the test is fast and reproducible: scan d = 1,2,3,...
  let i = 0n;
  const rng = () => ++i;

  // Match a 1-hex-nibble prefix so it's found within a tiny budget.
  const found = searchChild(publicPoint, { prefix: 'a' }, { maxTries: 100000, rng });
  assert.ok(found, 'should find a 1-nibble match quickly');

  // The search output is PUBLIC-only: the address + the child scalar + try count.
  // It must NOT contain the secret scalar or any private key.
  const exported = JSON.stringify(found);
  assert.ok(!exported.includes(secretScalar.slice(2)), 'secret scalar must not leak');
  assert.ok(found.address.startsWith('0x'));
  assert.ok(matches(found.address, { prefix: 'a' }));

  // Crucially, recomputing the candidate address from the public point + the returned child
  // scalar reproduces it — proving the searcher needed nothing private.
  assert.equal(addressForChild(publicPoint, found.childScalar), found.address);

  // And only the OFFLINE combine (which needs the secret) yields a usable key.
  const { privateKey } = combineKeys(secretScalar, found.childScalar, found.address);
  assert.equal(computeAddress(privateKey), found.address);
});

test('combineKeys guards against a wrong/mismatched half', () => {
  const a = makeUserKey();
  const b = makeUserKey(); // a DIFFERENT user secret
  const dHex = '0x' + (42n).toString(16).padStart(64, '0');
  const expected = addressForChild(a.publicPoint, dHex);

  // Combining b's secret with a's child scalar must NOT match a's expected address.
  assert.throws(
    () => combineKeys(b.secretScalar, dHex, expected),
    /!= expected/,
    'mismatched halves must be rejected'
  );
});

test('matches honours prefix and suffix, case-insensitively', () => {
  const addr = '0xABcd00000000000000000000000000000000bEEF'; // mixed case, no checksum needed
  assert.ok(matches(addr, { prefix: 'abcd' }));
  assert.ok(matches(addr, { suffix: 'BEEF' }));
  assert.ok(matches(addr, { prefix: 'AB', suffix: 'ef' }));
  assert.ok(!matches(addr, { prefix: 'dead' }));
});

test('searchChild rejects an empty / non-hex pattern fast', () => {
  const { publicPoint } = makeUserKey();
  assert.throws(() => searchChild(publicPoint, {}), /needs a prefix/);
  assert.throws(
    () => searchChild(publicPoint, { prefix: 'xyz' }, { maxTries: 1 }),
    /hex/
  );
});

test('generateVanity end-to-end (trusted single-machine) with combine', () => {
  let i = 0n;
  const rng = () => ++i;
  const res = generateVanity({ prefix: 'f' }, { maxTries: 100000, rng, combine: true });
  assert.ok(res, 'should find a 1-nibble match');
  assert.ok(matches(res.address, { prefix: 'f' }));
  assert.ok(res.privateKey, 'combine:true should reveal the private key');
  assert.equal(computeAddress(res.privateKey), res.address);

  // Without combine, no private key is present in the result.
  let j = 0n;
  const res2 = generateVanity({ prefix: 'f' }, { maxTries: 100000, rng: () => ++j });
  assert.equal(res2.privateKey, undefined);
});
