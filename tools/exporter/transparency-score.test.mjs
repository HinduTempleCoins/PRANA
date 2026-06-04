// transparency-score.test.mjs — offline tests for the clarity score.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeTransparencyScore,
  scoreConcentration,
  scoreMintAuthority,
  scoreLpLock,
  grade,
  WEIGHTS,
} from "./transparency-score.mjs";

test("WEIGHTS sum to exactly 1.0", () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}`);
});

// A clean token: dispersed holders, renounced mint, fully locked LP.
const cleanToken = {
  totalSupply: "1000",
  holders: [
    { address: "0x1", balance: "50", isContract: false },
    { address: "0x2", balance: "50", isContract: false },
    { address: "0xlp", balance: "500", isContract: true }, // LP/vault
    { address: "0x3", balance: "10", isContract: false },
  ],
  mintAuthority: { renounced: true },
  lpLock: { locked: true, fraction: 1 },
};

// A rug-prone token: one whale holds ~95%, active mint, no lock.
const ruggyToken = {
  totalSupply: "1000",
  holders: [
    { address: "0xwhale", balance: "950", isContract: false },
    { address: "0x2", balance: "50", isContract: false },
  ],
  mintAuthority: { renounced: false, owner: "0xdeployer" },
  lpLock: { locked: false },
};

test("clean token scores high (A/B) with no flags", () => {
  const r = computeTransparencyScore(cleanToken);
  assert.ok(r.score >= 70, `expected >=70, got ${r.score}`);
  assert.ok(["A", "B"].includes(r.grade));
  assert.equal(r.flags.length, 0);
  assert.equal(r.confidence, 1);
});

test("ruggy token scores low (D/F) and raises all flags", () => {
  const r = computeTransparencyScore(ruggyToken);
  assert.ok(r.score <= 45, `expected <=45, got ${r.score}`);
  assert.ok(["D", "F"].includes(r.grade));
  assert.deepEqual(
    r.flags.sort(),
    ["HIGH_CONCENTRATION", "LP_UNLOCKED", "MINT_AUTHORITY_ACTIVE"].sort(),
  );
});

test("concentration sub-score = 1 - top10 fraction", () => {
  const c = scoreConcentration({
    totalSupply: "100",
    holders: [{ address: "0x1", balance: "30", isContract: false }],
  });
  assert.equal(c.top10Fraction, 0.3);
  assert.ok(Math.abs(c.sub - 0.7) < 1e-9);
});

test("mint authority: renounced=1.0, active=0.2, unknown=null", () => {
  assert.equal(scoreMintAuthority({ mintAuthority: { renounced: true } }).sub, 1);
  assert.equal(scoreMintAuthority({ mintAuthority: { renounced: false } }).sub, 0.2);
  assert.equal(scoreMintAuthority({ mintAuthority: null }).sub, null);
});

test("LP lock: unlocked floors at 0.1, full lock = 1.0", () => {
  assert.equal(scoreLpLock({ lpLock: { locked: false } }).sub, 0.1);
  assert.equal(scoreLpLock({ lpLock: { locked: true, fraction: 1 } }).sub, 1);
});

test("missing facts lower confidence but still score on what is known", () => {
  const r = computeTransparencyScore({
    totalSupply: "100",
    holders: [{ address: "0x1", balance: "10", isContract: false }],
    // no mintAuthority, no lpLock
  });
  assert.ok(r.score != null);
  // only concentration(0.35)+contractRatio(0.15) present = 0.5 coverage
  assert.equal(r.confidence, 0.5);
});

test("empty facts yield null score, not a crash", () => {
  const r = computeTransparencyScore({});
  assert.equal(r.score, null);
  assert.equal(r.grade, null);
  assert.equal(r.confidence, 0);
});

test("grade thresholds", () => {
  assert.equal(grade(90), "A");
  assert.equal(grade(70), "B");
  assert.equal(grade(55), "C");
  assert.equal(grade(40), "D");
  assert.equal(grade(10), "F");
});
