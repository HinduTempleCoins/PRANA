// license-router.test.mjs — proves the deterministic license-tag -> posture routing
// (AA2-4). Pure function, no I/O, no deps. Run: node --test license-router.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  routeLicense,
  needsRightsReview,
  POSTURE,
  HOST_FAMILIES,
} from './license-router.mjs';

// --- HOST: every free-to-host family serves its own bytes -------------------

test('PD / CC0 / CC-BY / CC-BY-SA / gov / user-original all route to HOST', () => {
  for (const licenseFamily of HOST_FAMILIES) {
    assert.equal(
      routeLicense({ licenseFamily }),
      POSTURE.HOST,
      `${licenseFamily} should HOST`,
    );
  }
});

test('a PD scan and a user-original upload both HOST', () => {
  assert.equal(routeLicense({ licenseFamily: 'PD', source: 'archive.org' }), 'HOST');
  assert.equal(
    routeLicense({ licenseFamily: 'user-original', source: 'user-upload' }),
    'HOST',
  );
});

// --- EMBED: copyrighted via an OFFICIAL licensed player ---------------------

test('copyrighted-3p with sourceLicensed=true routes to EMBED', () => {
  assert.equal(
    routeLicense({
      licenseFamily: 'copyrighted-3p',
      source: 'youtube.com',
      sourceLicensed: true,
    }),
    POSTURE.EMBED,
  );
});

// --- REJECT: copyrighted via an UNLICENSED source ---------------------------

test('copyrighted-3p with sourceLicensed=false routes to REJECT', () => {
  assert.equal(
    routeLicense({
      licenseFamily: 'copyrighted-3p',
      source: '2embed.scraper',
      sourceLicensed: false,
    }),
    POSTURE.REJECT,
  );
});

test('copyrighted-3p with sourceLicensed missing routes to REJECT (default-deny)', () => {
  assert.equal(routeLicense({ licenseFamily: 'copyrighted-3p' }), POSTURE.REJECT);
  // Truthy-but-not-true must not slip through as EMBED.
  assert.equal(
    routeLicense({ licenseFamily: 'copyrighted-3p', sourceLicensed: 'yes' }),
    POSTURE.REJECT,
  );
});

// --- AGGREGATE: CC-NC, unknown, and anything else ---------------------------

test('CC-NC routes to AGGREGATE (NonCommercial is not host-eligible)', () => {
  assert.equal(routeLicense({ licenseFamily: 'CC-NC' }), POSTURE.AGGREGATE);
});

test('unknown license routes to AGGREGATE', () => {
  assert.equal(routeLicense({ licenseFamily: 'unknown' }), POSTURE.AGGREGATE);
});

test('an unrecognized / malformed family resolves conservatively to AGGREGATE', () => {
  assert.equal(routeLicense({ licenseFamily: 'made-up' }), POSTURE.AGGREGATE);
  assert.equal(routeLicense({}), POSTURE.AGGREGATE);
  assert.equal(routeLicense(null), POSTURE.AGGREGATE);
  assert.equal(routeLicense(undefined), POSTURE.AGGREGATE);
});

// --- needsRightsReview: flags gate promotion, not posture -------------------

test('person/brand/model-release/trademark flags trigger a rights review', () => {
  assert.equal(
    needsRightsReview({ licenseFamily: 'CC-BY', flags: ['person'] }),
    true,
  );
  assert.equal(
    needsRightsReview({ licenseFamily: 'CC-BY', flags: ['trademark'] }),
    true,
  );
});

test('no flags => no rights review, and flags never change the posture', () => {
  const tag = { licenseFamily: 'CC-BY', flags: ['person'] };
  assert.equal(needsRightsReview(tag), true);
  // The flag does NOT downgrade a host-eligible asset.
  assert.equal(routeLicense(tag), POSTURE.HOST);
  assert.equal(needsRightsReview({ licenseFamily: 'PD' }), false);
  assert.equal(needsRightsReview({ licenseFamily: 'PD', flags: [] }), false);
});
