# PRANA Ley Rider

A line-rider-style **draw-and-ride** physics game. You sketch a track with the pointer, then
let a sled rider loose on it and watch hand-rolled segment physics carry it down the lines.
Plain JavaScript ES modules, Phaser for rendering, Vite for dev/build, procedurally-drawn art
(no binary assets). The track format is content-hashed (keccak256) so tracks can later be
registered/scored on chain without changing gameplay.

## Quick start

```bash
cd games/ley-rider
npm install        # phaser + vite only (already vendored if node_modules/ exists)
npm run dev        # http://localhost:5173 — draw a track, press Enter to ride
npm test           # pure-logic unit tests (node --test) — physics, hashing, serialization

npm run build:clean    # -> dist-clean/   (public funnel: NO crypto/wallet/voucher strings)
npm run build:crypto   # -> dist-crypto/  (settlement rails active)
```

## Controls

| Action | Key / input |
| --- | --- |
| Draw track | drag the pointer |
| Boost line (accelerates the rider) | **B**, then draw |
| Normal line | **N** |
| Eraser | **E** (click/drag near a segment) |
| Place start flag | **S**, then click |
| Place finish flag | **F**, then click |
| Pan the (unbounded) canvas | right-drag, or hold **space** + drag |
| Ride / stop | **Enter** |
| Clear all lines | **C** |
| Save / load named track | **Ctrl+S** / **Ctrl+L** |
| Export / import JSON | **Ctrl+X** / **Ctrl+I** |

Draw mode lays polyline track on an unbounded, pannable canvas; drag points are simplified
with a minimum-distance threshold so the segment density stays sane. Ride mode spawns a sled
at the start flag; the camera follows it. Reach the **finish flag** to lock a time (best time
per track is kept). Fall off the world (below the lowest track point + a margin) and the run
is over. There is no crash model in v1 — the rider just rides. **Distance ridden = score**
when there is no finish; **time** is the score when there is one.

## Architecture

```
index.html                  # mount + module entry + control hints
src/
  main.js                   # Phaser game config (Boot -> Menu -> Track)
  config.js                 # CRYPTO_BUILD switch + PHYSICS / DRAW tuning constants
  scenes/
    BootScene.js            # procedural textures (sled, flags) — no binary assets
    MenuScene.js            # title + controls + START
    TrackScene.js           # the game: draw mode + ride mode + camera + HUD + persistence UI
  logic/
    physics.js              # PURE hand-rolled segment physics (no engine dep) — tested
    track.js                # canonical serialization, keccak track hash, simplify, localStorage
  lib/
    keccak.js               # vendored ~120-line pure-JS keccak256 (Solidity-compatible)
  data/
    runVoucher.js           # settlement rails (CRYPTO build only; clean build => no-op stub)
data/
  runVoucher.fixture.json   # documentation/fixture-server parity for the voucher shape
test/                       # node --test: physics, keccak, track, runVoucher
vite.config.js              # dual build (__CRYPTO_BUILD__ literal -> dead-code elimination)
```

All gameplay-critical math lives in `src/logic/` as **pure functions with no Phaser imports**,
so it runs unchanged under `node --test`. The scenes are thin: they translate input/render and
call into the logic.

## Physics notes (the "feel")

The integrator is a fixed-step (1/120 s) semi-implicit Euler loop. Each step (`stepRider`):

1. **Integrate velocity** — add gravity, then a mild speed-scaled air drag (applied per-second
   via `dt`, so it is frame-rate independent and only a gentle bleed).
2. **Integrate position** by the new velocity.
3. **Find the nearest track segment** within the collision radius (`closestPointOnSegment` +
   a linear scan; fine for hand-drawn tracks).
4. **Resolve penetration** — push the body out along the segment normal, kill the inward
   normal velocity (restitution 0 => sleds slide, they don't trampoline).
5. **Tangential response** — normal lines apply friction (slow the slide); **boost** lines
   apply *negative* friction (net acceleration) **plus** a flat tangential impulse in the
   direction of travel. Friction/boost are `dt`-scaled against the 1/120 s reference step so
   the feel is frame-rate independent. Speed is hard-clamped to `maxSpeed`.

Tuning constants live in `config.js > PHYSICS` (px / seconds):

| Constant | Value | What it does |
| --- | --- | --- |
| `gravity` | 1400 | snappy arcade-y fall (not earth-real; tuned for fun) |
| `airDamping` | 0.0008 | gentle speed-scaled drag so terminal velocity is finite |
| `friction` | 0.02 | tangential slowdown on normal lines per reference step |
| `boostFriction` | −0.06 | NEGATIVE => boost lines accelerate the slide |
| `boostImpulse` | 22 | flat px/s kick per step along a boost segment |
| `collisionRadius` | 9 | rider body radius = collision capture distance |
| `restitution` | 0.0 | no bounce — slide physics |
| `maxSpeed` | 2600 | integrator safety clamp on long boost chains |
| `fallMargin` | 400 | px below lowest track point => "fell off the world" |

How it feels: on a gentle downslope the sled eases into a slide and accelerates smoothly;
flat segments let it coast and bleed speed to friction; steep drops build real speed fast
(capped by drag + `maxSpeed`); boost lines noticeably kick it forward and are the way to
clear gaps. Resting on a flat line, the rider pins to the surface with no jitter or sink-through.

## Track-hash spec (settled now for the future TrackRegistry)

A track serializes to a **canonical compact JSON string**:

```json
{"v":1,"lines":[[x1,y1,x2,y2,"n"],...],"start":[x,y],"finish":[x,y]}
```

- `v` — format version (1).
- `lines` — array of `[x1,y1,x2,y2,type]`; `type` is `"n"` (normal) or `"b"` (boost).
  Coordinates are **rounded to integers** (tracks are drawn in whole pixels; this makes the
  hash insensitive to sub-pixel float noise).
- `start` / `finish` — `[x,y]` or `null`.

The string is built **by hand** (fixed key order, fixed array formatting) so the bytes are
deterministic across JS engines. **`trackHash = keccak256(utf8Bytes(canonicalJsonString))`**,
which is byte-identical to Solidity's `keccak256(abi.encodePacked(canonicalJsonString))`
(abi.encodePacked of a lone string is just its UTF-8 bytes — no length prefix, no padding).

**Canonical means NO sorting.** Draw order *is* content: two tracks with the same segments in
a different order ride identically but hash **differently** and are distinct tracks. This is
intentional and tested (`test/track.test.mjs`) — do not "normalize" by sorting later, or you
break every previously-registered hash.

### Future `TrackRegistry` contract (intended interface — NOT yet deployed)

The hash format above is frozen so this contract can be written later without migrating data:

```solidity
interface ITrackRegistry {
    // Author claims a track by its canonical-JSON keccak256 hash. First claimer wins.
    function registerTrack(bytes32 trackHash) external;
    function authorOf(bytes32 trackHash) external view returns (address);

    // Best run per track, posted via the attester-signed leaderboard rails (see below).
    // score = inverted time (faster => higher) for finished runs; distance otherwise.
    function recordRun(bytes32 trackHash, address player, uint256 score) external;
    function bestRun(bytes32 trackHash) external view returns (address player, uint256 score);

    event TrackRegistered(bytes32 indexed trackHash, address indexed author);
    event RunRecorded(bytes32 indexed trackHash, address indexed player, uint256 score);
}
```

Because the off-chain hash equals what Solidity computes for the same canonical string, an
author can register a track they share as a plain JSON file and the on-chain identity matches.

## Settlement / voucher flow (crypto build only)

`src/data/runVoucher.js` mirrors the attester-signed voucher pattern of the existing
`contracts/contracts/ArcadeFaucet.sol` and `ArcadeLeaderboard.sol`:

1. On a completed run the game builds a summary `{ player, gameId:"ley-rider", score, runRef }`
   where `score` is the **inverted best time** (`max(0, SCORE_BASE − timeMs)`, so faster =
   higher) for a finished run, or **distance** for an unfinished one, and `runRef` is the
   `trackHash`.
2. It POSTs that summary to a configurable **attester endpoint** (`SETTLEMENT.attesterUrl` in
   `config.js`, injected by the private wallet workspace).
3. The attester (holding `ATTESTER_ROLE`) returns an **EIP-712 voucher**, which the player
   redeems on chain via `ArcadeLeaderboard.postScore(...)` / `ArcadeFaucet.claim(...)`. The
   game never holds a key — it only posts a summary and shows the result.

This path is **fixture-stubbed and offline-safe** (no endpoint, offline, or any error => a
local stub; it never throws into the game loop) and is **dead-code-eliminated from the clean
build**: in `dist-clean` the whole body collapses to `return { stub: true }` and the bundler
drops the network code, the fixture object, and all crypto vocabulary. Verified by grepping
`dist-clean/` for `attester|voucher|ArcadeFaucet|EIP-712|wallet|settlement` (empty).

## Tooling

- **Phaser 4** (rendering / input / camera), **Vite 8** (dev server + build). Installed into
  this folder only (`games/ley-rider/node_modules`); no engine in the physics path.
- Pure-logic **tests** run on `node --test` with zero browser/Phaser dependency.
- **Dual build** via the `__CRYPTO_BUILD__` Vite define (see `vite.config.js`): `build:clean`
  is the safe public funnel (default), `build:crypto` enables settlement rails.
- keccak256 is **vendored** (`src/lib/keccak.js`, ~120 lines, no deps) because `js-sha3` is not
  in the phaser/vite dependency tree and the game ships zero runtime crypto libraries. It is
  verified byte-for-byte against published Solidity keccak256 vectors in `test/keccak.test.mjs`.
