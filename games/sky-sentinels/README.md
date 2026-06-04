# PRANA Sky Sentinels

**Sky Sentinels** is the PRANA fixed-shooter arcade game. You ride a ship along the bottom of
the screen and shoot upward at a descending grid of **sentinels** — original PRANA **sigils**,
not the classic arcade aliens — that march sideways, drop down at the walls, accelerate as
their ranks thin, and rain bolts down at you. Three destructible **cover arcs** are all that
stand between you and their fire. Plain JavaScript ES modules, Phaser for rendering, Vite for
dev/build, and **every texture drawn procedurally to canvas** (no binary assets). The game is
fully playable on its own and is wired so finished runs can settle to an on-chain reward
voucher — without the game ever holding a key — via a build flag that is dead-code-eliminated
from the public build.

This mirrors the proven scaffold in `games/naga/` (same dual-build mechanism, same
fixture→chain seam pattern, same procedural-texture approach).

## Trade-dress note (original art, on purpose)

The sentinels are **original geometric sigils** — concentric rings, faceted diamonds, double
chevrons, hexagonal lattices — drawn procedurally in `BootScene`, in the PRANA dark-field /
bright-core palette. They are a **deliberate departure** from the protected character art of
the 1978 arcade fixed-shooter; only the *genre mechanics* (a marching, descending, accelerating
grid behind destructible cover) are shared, which are not protectable. The menu states this in
the UI as well.

## Quick start

```bash
cd games/sky-sentinels
npm install        # phaser + vite only (confined to this directory)
npm run dev        # http://localhost:5173 — play it
npm test           # pure-logic unit tests (node --test)
```

## Controls

- **Move:** `←` / `→` (or `A` / `D`) — slide along the bottom band.
- **Fire:** `Space` — one player bolt on screen at a time (classic cadence).
- Shelter behind the **cover arcs**; they erode from both your shots and the sentinels'.

## The game

- **The formation.** An 8×5 grid of sentinels marches sideways in discrete steps, jumps down
  a row and reverses whenever the live edge reaches a wall, and **accelerates** as you thin its
  ranks (step cadence scales with the fraction still alive) and on each new wave.
- **Score by row tier.** Top rows are worth more (`40 / 30 / 20 / 10 / 10` top→bottom) — the
  table is `RULES.rowScore`.
- **Their fire.** On each formation step a random column's **lowest** sentinel may drop a bolt
  (capped on-screen count). A bolt that reaches your ship costs a life.
- **Cover.** Three destructible arcs sit between you and the grid; each takes several hits,
  visibly chipping away (and blocking both sides' bolts) until destroyed. Cover is **refreshed**
  each wave.
- **Three lives.** Lose one to a sentinel bolt; lose the run if lives hit zero **or** if the
  formation descends far enough to "land."
- **Waves.** Clear every sentinel and a faster wave spawns.
- **Juice:** per-row original sigil textures, formation march/drop, burst on each kill, and
  screen shake on a hit.

### Tuning

All tuning lives in `RULES` in `src/config.js`: `lives`, the `player` block (`speed` /
`cooldownMs` / `boltSpeed`), the `grid` block (cols/rows/spacing/`marchX`/`dropY`/margins), the
`step` block (`baseStepMs` / `minStepMs` / `waveSpeedup`), the `enemyBolt` block, the `cover`
block (`count` / `cells` / geometry), the `rowScore` tier table, and `landingY`.

## Pure logic (`src/logic/sentinels.js`)

The entire simulation core is pure and Phaser-free, so it runs under `node --test`:

- **Grid step / accel** — `makeFormation`, `cellPos`, `stepFormation` (march-by-`marchX`, or
  reverse-and-drop at a wall, never both in one step), `stepInterval` (faster as ranks thin and
  across waves, clamped to a floor).
- **Bolt collision** — `boltHitsSentinel` (point/circle against each live sentinel's current
  pixel center), `killSentinel`, `rowScoreFor`.
- **Enemy firing** — `bottomShooters` (lowest live sentinel per column), `chooseEnemyShot`
  (seedable dice + column pick → pixel origin).
- **Cover erosion** — `makeCovers`, `boltHitsCover`, `erodeCover` (chip one cell, floored at 0).
- **Movers / player** — `stepVerticalBolts` (advance + cull off-field), `clampPlayerX`,
  `enemyBoltHitsPlayer` (box check), plus `liveCount` / `liveColumnExtent` / `lowestLiveY` for
  wall and landing logic.

All mutating-looking resolvers are **pure** (no input mutation), which the tests assert.

## Settlement rails (crypto build only)

`src/data/scoreVoucher.js` builds the **exact** payload the on-chain reward path expects. The
game **never holds keys and never signs** — at game-over it POSTs the run to a configurable
**attester** endpoint; the server signs an EIP-712 voucher the player later redeems at
`ArcadeFaucet`.

- **EIP-712 domain:** `name="ArcadeFaucet"`, `version="1"`.
- **Voucher struct:** `Voucher(address player,uint256 amount,bytes32 scoreRef,uint256 deadline,uint256 nonce)`.
- **Redeem call:** `claim(player, amount, scoreRef, deadline, nonce, signature)` — see
  `toClaimArgs(voucher)` for the exact positional tuple.
- `gameId` is `"sky-sentinels"`.

`scoreRef` is computed **server-side** as `keccak256(gameId, player, score, runHash)` (the
game ships no hashing/crypto library). When `SETTLEMENT.attesterUrl` is null the module
returns a **documented fixture voucher** (`fixtureVoucher`, flagged `fixture:true`, a
placeholder signature — not redeemable) so the game-over flow is demoable offline.

## Dual build (clean vs crypto)

One build-time flag, `CRYPTO_BUILD` (`vite.config.js` injects `__CRYPTO_BUILD__`; read in
`src/config.js`).

| build  | command                | output         | CRYPTO_BUILD | settlement path                  | crypto UI strings |
|--------|------------------------|----------------|--------------|----------------------------------|-------------------|
| clean  | `npm run build:clean`  | `dist-clean/`  | `false`      | **dead-code-eliminated**         | none              |
| crypto | `npm run build:crypto` | `dist-crypto/` | `true`       | active (attester POST + voucher) | allowed           |

Plain `npm run build` defaults to **clean** (the safest public funnel).

**Verified:** the clean bundle contains **zero** `wallet` / `jsonrpc` / `voucher` / `nft`
strings — `requestScoreVoucher()` returns early on the build-time-false literal and Vite
drops the whole branch.

## Layout

```
index.html              # mount + module entry
src/
  config.js             # field size + RULES (player/grid/step/bolts/cover/scoring) + CRYPTO_BUILD flag
  main.js               # Phaser game config, scene list
  scenes/
    BootScene.js        # bakes all procedural textures (player, original sigils, bolts, cover, starfield)
    MenuScene.js        # title + how-to + trade-dress note + Play
    PlayScene.js        # the whole game loop, input, juice, game-over + settlement
  data/
    scoreVoucher.js     # EIP-712 voucher payload + attester POST (crypto build only)
  logic/
    sentinels.js        # PURE: grid step/accel, bolt collision, enemy firing, cover erosion
test/
  logic.test.mjs        # node --test
```

## Notes / constraints

- One self-contained `npm install` (`phaser`, `vite`) confined to `games/sky-sentinels/`.
- Phaser **4.x**; placeholder art only — every texture is drawn to canvas in `BootScene`.
- PUBLIC repo: only the **PRANA** brand appears in shipped strings; no other ecosystem names.
- Original theme: PRANA sentinel "sigils" — see the trade-dress note above.
```
