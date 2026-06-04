# PRANA Void Shards

**Void Shards** is the PRANA asteroids-style arcade game. A lone ship drifts through a
wrap-around void; you rotate, thrust against inertia, and fire bolts to shatter drifting
**void shards** before they hit you. Plain JavaScript ES modules, Phaser for rendering, Vite
for dev/build, and **every texture drawn procedurally to canvas** (no binary assets). The
game is fully playable on its own and is wired so finished runs can settle to an on-chain
reward voucher — without the game ever holding a key — via a build flag that is
dead-code-eliminated from the public build.

This mirrors the proven scaffold in `games/naga/` (same dual-build mechanism, same
fixture→chain seam pattern, same procedural-texture approach).

## Quick start

```bash
cd games/void-shards
npm install        # phaser + vite only (confined to this directory)
npm run dev        # http://localhost:5173 — play it
npm test           # pure-logic unit tests (node --test)
```

## Controls

- **Rotate:** `←` / `→` (or `A` / `D`).
- **Thrust:** `↑` (or `W`) — Newtonian thrust; you keep your momentum and coast.
- **Fire:** `Space` — bolts have a cooldown and a max on-screen count.
- The screen **wraps**: leave one edge, re-enter the opposite one (ship, shards, and bolts).
- After a death you respawn at center with a brief **invulnerability** flash.

## The game

- **Three lives.** A shard, the saucer, or a saucer bolt touching your ship costs a life;
  you respawn at center with ~2.2 s of invulnerability.
- **Splitting shards.** Each **large** shard splits into **2 medium**, each medium into
  **2 small**, and small shards are destroyed outright — the classic break-down cascade.
- **Score by size.** Small shards are worth the most (they're hardest to hit): large `20`,
  medium `50`, small `100`. The **saucer** is worth `200`.
- **Waves.** Clear every shard and the next wave spawns with **+1 large shard** and the same
  cascade — the field gets busier over time.
- **The saucer.** Occasionally a hostile saucer crosses the field, **aiming at your ship**
  and firing a small 3-bolt **spread** with aim jitter (beatable, not a sniper). Shoot it for
  bonus points or dodge it.
- **Juice:** thrust-flare ship texture, faceted crystalline shards that tumble, glow-burst on
  every destroy, ship blink during invulnerability, and screen shake on death.

### Tuning

All tuning lives in `RULES` in `src/config.js`: `lives`, `respawnInvulnMs`, the full `ship`
physics block (`turnRate` / `thrust` / `drag` / `maxSpeed`), the `bolt` block (`speed` /
`lifeMs` / `cooldownMs` / `max`), the per-tier `shards` table (radius / speed / score / split
target & count), wave growth, and the `saucer` block.

## Pure logic (`src/logic/shards.js`)

The entire simulation core is pure and Phaser-free, so it runs under `node --test`:

- **Inertia integration** — `stepShip` (rotate, thrust along the facing, frame-rate-independent
  drag via `drag^dt`, max-speed clamp, integrate + wrap).
- **Toroidal space** — `wrapScalar` / `wrapPos` / `integratePos`, plus `wrapDelta` /
  `wrapDistance` so collisions are correct **across the seam** (an object at the right edge is
  close to one at the left edge).
- **Collision circles** — `circlesOverlap` underpins bolt↔shard, ship↔shard, ship↔bolt, and
  bolt↔saucer checks.
- **Split tables** — `splitShard` (large→2 medium→2 small→∅), children inherit the parent
  position and fan out by a seedable spread RNG.
- **Frame resolvers** — `resolveBoltShardHits` (each bolt consumes the first shard it hits and
  splits it; pure, returns new arrays + score), `shipShardCollision`.
- **Saucer aim** — `saucerAimHeading` (shortest-path toroidal aim + jitter), `saucerFire`
  (3-bolt spread).
- **Waves** — `largeShardsForWave`, `spawnWave` (count grows per wave; never spawns on the
  ship's center).

All resolvers are **pure** (no input mutation), which the tests assert directly.

## Settlement rails (crypto build only)

`src/data/scoreVoucher.js` builds the **exact** payload the on-chain reward path expects. The
game **never holds keys and never signs** — at game-over it POSTs the run to a configurable
**attester** endpoint; the server signs an EIP-712 voucher the player later redeems at
`ArcadeFaucet`.

- **EIP-712 domain:** `name="ArcadeFaucet"`, `version="1"`.
- **Voucher struct:** `Voucher(address player,uint256 amount,bytes32 scoreRef,uint256 deadline,uint256 nonce)`.
- **Redeem call:** `claim(player, amount, scoreRef, deadline, nonce, signature)` — see
  `toClaimArgs(voucher)` for the exact positional tuple.
- `gameId` is `"void-shards"`.

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
  config.js             # field size + RULES (physics/bolts/shards/saucer) + CRYPTO_BUILD flag
  main.js               # Phaser game config, scene list
  scenes/
    BootScene.js        # bakes all procedural textures (ship, shards, bolts, saucer, starfield)
    MenuScene.js        # title + how-to + Play
    PlayScene.js        # the whole game loop, input, juice, game-over + settlement
  data/
    scoreVoucher.js     # EIP-712 voucher payload + attester POST (crypto build only)
  logic/
    shards.js           # PURE: inertia, wrap, split tables, collision circles, saucer aim, waves
test/
  logic.test.mjs        # node --test
```

## Notes / constraints

- One self-contained `npm install` (`phaser`, `vite`) confined to `games/void-shards/`.
- Phaser **4.x**; placeholder art only — every texture is drawn to canvas in `BootScene`.
- PUBLIC repo: only the **PRANA** brand appears in shipped strings; no other ecosystem names.
- Original theme: "void shards" in a PRANA dark-field / bright-core palette — not a clone of
  any specific commercial asteroids art.
```
