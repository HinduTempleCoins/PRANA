// Settlement rails — crypto build ONLY.
//
// After a completed run, the game can POST a run summary to a configurable off-chain
// ATTESTER endpoint, which (in production) returns an EIP-712 voucher the player redeems on
// chain. The voucher pattern matches the ArcadeFaucet / ArcadeLeaderboard contracts in
// contracts/contracts/:
//   - ArcadeLeaderboard.postScore(player, gameId, season, score, nonce, deadline, sig)
//   - ArcadeFaucet.claim(player, amount, scoreRef, deadline, nonce, sig)
// In both, the off-chain attester signs and the chain verifies — the game never holds a key.
//
// This module is DEAD-CODE-ELIMINATED from the clean build: every entry point short-circuits
// on the `CRYPTO_BUILD` literal, so the bundler drops the network code and all crypto strings
// from dist-clean. It is also fully fixture-stubbed: with no endpoint configured (or offline,
// or on any error) it resolves to a local stub and NEVER throws into the game loop.
//
// SCORE CONVENTION: leaderboards want "higher = better". For a time-trial, a faster run is
// better, so we submit an INVERTED time score: max(0, SCORE_BASE - bestTimeMs). Distance runs
// (no finish flag) submit the distance directly. `runRef` is the canonical trackHash, tying
// the score to exact track content for the future TrackRegistry.

import { CRYPTO_BUILD, GAME_ID, SETTLEMENT } from '../config.js';

// Time-trial inversion base. Any run faster than ~16.6 minutes yields a positive score; the
// faster the run, the higher the number. Documented constant so the attester can mirror it.
export const SCORE_BASE = 1_000_000;

// Build the run summary the attester signs over. Pure + exported so it is unit-testable.
//   result: { finished: bool, timeMs: number, distance: number, trackHash: '0x..' }
export function buildRunSummary(result, player = SETTLEMENT.player) {
  const score = result.finished
    ? Math.max(0, SCORE_BASE - Math.round(result.timeMs))
    : Math.round(result.distance);
  return {
    player: player || null,
    gameId: GAME_ID,
    score,
    runRef: result.trackHash,
    finished: !!result.finished,
    timeMs: Math.round(result.timeMs),
    distance: Math.round(result.distance),
  };
}

// Post a completed run for settlement. Returns the signed voucher, or a stub.
// NEVER throws — settlement is best-effort and must not interrupt play.
//
// IMPORTANT (clean-build hygiene): the entire settlement body — including the fixture stub
// and every crypto string — lives behind the `CRYPTO_BUILD` literal. In the clean build this
// collapses to `return { stub: true }` and the bundler dead-code-eliminates the network code,
// the fixture object AND all crypto vocabulary. We INLINE the stub object (rather than import
// a JSON file) so the clean build emits no settlement chunk at all. The canonical fixture
// also lives at data/runVoucher.fixture.json for documentation / fixture-server parity.
export async function postRun(result) {
  if (!CRYPTO_BUILD) return { stub: true };

  const fixture = {
    ok: true,
    stub: true,
    voucher: {
      player: '0x0000000000000000000000000000000000000000',
      gameId: GAME_ID,
      score: 0,
      runRef: '0x' + '0'.repeat(64),
      nonce: 0,
      deadline: 0,
      signature: '0x',
    },
  };

  const summary = buildRunSummary(result);
  const { attesterUrl } = SETTLEMENT;

  // No endpoint configured => offline-safe fixture stub (still lets the UI show "submitted").
  if (!attesterUrl) {
    return { ...fixture, stub: true, summary };
  }

  try {
    const res = await fetch(attesterUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summary),
    });
    if (!res.ok) throw new Error(`attester ${res.status}`);
    const voucher = await res.json();
    return { ...voucher, stub: false, summary };
  } catch (err) {
    // Unreachable / rejected => graceful fixture fallback (matches the chainLoader pattern).
    console.warn('[runVoucher] falling back to fixture stub:', err.message);
    return { ...fixture, stub: true, summary, error: err.message };
  }
}
