# PRANA Ibis Flight

**Ibis Flight** is a PRANA one-tap flier. A luminous ibis holds a fixed x while the temple
court scrolls past; **tap / space / click to flap** against gravity and thread the openings in
approaching pillar pairs. One point per pillar passed, speed ramps **gently** as you go, and a
single touch of a pillar, the ground, or the ceiling ends the run. Plain JavaScript ES modules,
Phaser for rendering, Vite for dev/build, and **every texture drawn procedurally to canvas**
(no binary assets). Finished runs can settle to an on-chain reward voucher — without the game
ever holding a key — via a build flag that is dead-code-eliminated from the public build.

This mirrors the scaffold in `games/naga/` (same dual-build mechanism, same fixture→chain
seam, same pure-logic + `node --test` pattern).

## Quick start

```bash
cd games/ibis-flight
npm install        # phaser + vite only (confined to this directory)
npm run dev        # http://localhost:5173 — play it
npm test           # pure-logic unit tests (node --test)
```

## Controls

- **Flap:** `Space`, `↑`, click, or tap. Each flap **replaces** vertical velocity with a fixed
  upward impulse (one-tap feel — mashing taps doesn't stack into a rocket).
- Gravity pulls you down to a terminal fall speed; the world does the rest.
- The first flap unfreezes a short **grace hover** at spawn. On game-over, tap to play again.

## The game

- A 480×640 portrait court. The ibis's x is fixed at `RULES.birdX`; the world scrolls left.
- **Pillar pairs** approach with a vertical **gap** (`RULES.gapHeight`) you must fly through.
  Everything above and below the gap is solid; touching it is death.
- **Score** = pillars passed. **Speed ramps gently** — `baseScrollSpeed + score·speedRampPerPoint`,
  clamped to `maxScrollSpeed` so it never becomes unplayable.
- **Death** on pillar contact, ground, or ceiling. Collision is a circle (`RULES.birdR`) vs the
  pillar columns and the two horizontal limits, with the bird's radius respected at the gap
  edges.
- **Juice:** a bright flash on each score, a velocity-driven dive/climb tilt, and a screen shake
  + red tint on death.

### Seeded gap sequence (why it's testable)

Gap positions are produced by a **seeded PRNG** (`makeRng`, mulberry32) in the pure logic, not
by `Math.random` scattered through the scene. The **same seed always yields the same run**, so:

- the gap sequence is fully **reproducible** and unit-testable (`gapSequence(seed, n, …)`), and
- the settlement payload ships the `seed`, letting the attester **replay the exact run** and
  re-verify the claimed score server-side.

The scene seeds once per run, draws the first pairs up front, and recycles each pair off the
left edge to the right with the next seeded gap — an infinite course from one deterministic
stream.

### Tuning

All physics/world numbers live in `RULES` (`src/config.js`): `gravity`, `flapImpulse`,
`maxFallSpeed`, `gapHeight`, `pillarSpacing`, `baseScrollSpeed` / `speedRampPerPoint` /
`maxScrollSpeed`, and the legal gap band (`gapMinFrac` / `gapMaxFrac`).

## Settlement rails (crypto build only)

`src/data/scoreVoucher.js` builds the **exact** payload the on-chain reward path expects. The
game **never holds keys and never signs** — at game-over it POSTs the run (including the gap
`seed`) to a configurable **attester** endpoint; the server replays the run, signs an EIP-712
voucher, and the player later redeems it at `ArcadeFaucet`.

Exact shapes mirrored from `contracts/contracts/ArcadeFaucet.sol`:

- **EIP-712 domain:** `name="ArcadeFaucet"`, `version="1"`.
- **Voucher struct:** `Voucher(address player,uint256 amount,bytes32 scoreRef,uint256 deadline,uint256 nonce)`.
- **Redeem call:** `claim(player, amount, scoreRef, deadline, nonce, signature)` — see
  `toClaimArgs(voucher)` for the exact positional tuple.

`scoreRef` is computed **server-side** as `keccak256(gameId, player, score, runHash)` (the game
ships no hashing/crypto library). When `SETTLEMENT.attesterUrl` is null the module returns a
**documented fixture voucher** (flagged `fixture:true`, placeholder signature — not redeemable)
so the game-over flow is demoable offline.

## Dual build (clean vs crypto)

One build-time flag, `CRYPTO_BUILD` (`vite.config.js` injects `__CRYPTO_BUILD__`; read in
`src/config.js`).

| build  | command                | output         | CRYPTO_BUILD | settlement path                  | crypto UI strings |
|--------|------------------------|----------------|--------------|----------------------------------|-------------------|
| clean  | `npm run build:clean`  | `dist-clean/`  | `false`      | **dead-code-eliminated**         | none              |
| crypto | `npm run build:crypto` | `dist-crypto/` | `true`       | active (attester POST + voucher) | allowed           |

Plain `npm run build` defaults to **clean** (the safest public funnel).

**Verified:** the clean bundle contains **zero** `wallet` / `jsonrpc` / `voucher` / `attester`
/ `nft` strings — `requestScoreVoucher()` returns early on the build-time-false literal and
Vite drops the whole branch.

## Layout

```
index.html              # mount + module entry
src/
  config.js             # world/RULES tuning + CRYPTO_BUILD flag + SETTLEMENT config
  main.js               # Phaser game config, scene list
  scenes/
    BootScene.js        # bakes procedural ibis/pillar/ground textures, then -> Menu
    MenuScene.js        # title + start
    PlayScene.js        # game loop, input, pillar recycling, scoring, game-over + settlement
  data/
    scoreVoucher.js     # EIP-712 voucher payload + attester POST (crypto build only)
  logic/
    flight.js           # PURE: seeded gaps, flap, gravity, collision, scoring, world step
test/
  logic.test.mjs        # node --test (25 cases)
```

## Tests

`src/logic/flight.js` is pure (no Phaser) so it runs under `node --test`: the seeded PRNG
(determinism + range), gap-band placement and reproducible `gapSequence`, the flap impulse
(non-stacking), gravity integration + terminal-speed clamp, ceiling/ground detection, pillar
collision (safe-in-gap, fatal-outside, radius-respecting edges, x-overlap gating), the gentle
speed ramp + clamp, per-pillar scoring (awarded once), the dead-state freeze, and a full
survivable-then-scoring mini run. Run `npm test`.

## Notes / constraints

- One self-contained `npm install` (`phaser`, `vite`) confined to `games/ibis-flight/`.
- Phaser **4.x**; placeholder art only — every texture is drawn to canvas in `BootScene`.
- PUBLIC repo: only the **PRANA** brand appears in shipped strings; no other ecosystem names.
```
