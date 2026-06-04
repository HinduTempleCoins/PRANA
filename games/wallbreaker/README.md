# PRANA Wallbreaker

**Wallbreaker** is the PRANA paddle/ball brick-breaker. Bounce the ball off your paddle to
smash an 8×6 wall of bricks, where the contact point on the paddle steers ("englishes") the
rebound angle. Plain JavaScript ES modules, Phaser for rendering, Vite for dev/build, and
**every texture drawn procedurally to canvas** (no binary assets). The game is fully playable
on its own and is wired so finished runs can settle to an on-chain reward voucher — without
the game ever holding a key — via a build flag that is dead-code-eliminated from the public
build.

This mirrors the proven scaffold in `games/naga/` (same dual-build mechanism, same
fixture→chain seam pattern, same skin-slot cosmetic shape).

## Trade-dress note

Wallbreaker is a generic paddle-and-ball brick-breaker. It uses **original art (procedural
PRANA-palette blocks/paddle/ball), original name, and original level layout**, and ships **no
trademarked names, logos, sounds, or marketing look-alikes**. The shared mechanics (a paddle,
a bouncing ball, a brick wall, lives, powerups) are generic genre conventions, not protectable
trade dress.

## Quick start

```bash
cd games/wallbreaker
npm install        # phaser + vite only (confined to this directory)
npm run dev        # http://localhost:5173 — play it
npm test           # pure-logic unit tests (node --test)
```

## Controls

- **Move paddle:** move the mouse / drag (or ← / → keys).
- **Launch ball:** click or **Space** (the ball rides the paddle until launched).
- Click on the game-over screen to restart.

## The game

- An **8×6 brick wall**. Brick **HP tiers run by row colour**: the top rows are tougher
  (red = 3 HP), middle amber = 2 HP, bottom cyan = 1 HP. Tougher bricks dim as they take hits.
- **Paddle english:** where the ball strikes the paddle sets the rebound angle — dead-centre
  sends it straight up, the edges fan it out to a steep angle (up to 60° off vertical). Ball
  **speed is preserved** on every bounce; only direction changes.
- **3 lives.** Drop the ball past the bottom and you lose one; out of lives ends the run.
- **Level advance:** clear the whole wall and the next level rebuilds the wall and **speeds
  the ball up by +10%** (compounding, clamped to a max so it stays controllable). A clear bonus
  is awarded.
- **Scoring:** each brick is worth `tier × 50 × level`; clearing the field adds a level bonus.
- **Powerups (scope kept tight):** broken bricks sometimes drop a capsule —
  **W = wide paddle** (timed) or **M = multiball** (splits your ball into three). Catch it
  with the paddle.

### Tuning

All tuning lives in `RULES` in `src/config.js`: `lives`, `ballRadius`, `paddleWidth/Height`,
`paddleY`, `powerupChance`, `powerupFallSpeed`, `widePaddleMs`. Field/brick geometry and speed
constants live in `src/logic/bounce.js` (`FIELD`, `BRICKS`, `ROW_HP`, `BASE_BALL_SPEED`,
`SPEED_PER_LEVEL`, `MAX_BALL_SPEED`).

## Skin slots (cosmetics)

`src/data/skins.js` loads a catalog from `data/skins.fixture.json`. Each skin is a **paddle/
ball/backdrop palette theme**, shaped to **mirror an on-chain cosmetic item** from
`contracts/contracts/ItemRegistry.sol`:

```json
{ "itemId": 30000, "name": "Prana Cyan",
  "palette": { "bg": "#05080f", "paddle": "#62d0ff", "ball": "#bff0ff" } }
```

- `itemId` **must be ≥ 30000** — ItemRegistry reserves `30_000 .. max` for cosmetics
  (`COSMETIC_MIN` / `COSMETIC_MINTER_ROLE`). The normalizer rejects out-of-range ids.
- `palette.{bg,paddle,ball}` are `#rrggbb`. (Brick colours come from the HP tiers in
  `logic/bounce.js` — those are gameplay identity, not a cosmetic.)
- Skins are selectable in the menu; `BootScene` bakes a procedural ball + paddle per skin.

**On-chain ownership gating (documented seam, not yet wired):** the clean build ships every
skin unlocked. With the wallet hook, the (private) wallet workspace will inject the player's
owned cosmetic ids (read from `ItemRegistry.balanceOf(player, itemId)` over RPC) and
`ownedSkins(catalog, ownedIds)` will filter the catalog to held items.

## Settlement rails (crypto build only)

`src/data/scoreVoucher.js` builds the **exact** payload the on-chain reward path expects. The
game **never holds keys and never signs** — at game-over it POSTs the run (`gameId:
"wallbreaker"`) to a configurable **attester** endpoint; the server signs an EIP-712 voucher
the player later redeems at `ArcadeFaucet`.

Exact shapes mirrored from `contracts/contracts/ArcadeFaucet.sol`:

- **EIP-712 domain:** `name="ArcadeFaucet"`, `version="1"`.
- **Voucher struct:** `Voucher(address player,uint256 amount,bytes32 scoreRef,uint256 deadline,uint256 nonce)`.
- **Redeem call:** `claim(player, amount, scoreRef, deadline, nonce, signature)` — see
  `toClaimArgs(voucher)` for the exact positional tuple.

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

**Verified:** the clean bundle contains **zero** `wallet` / `jsonrpc` / `voucher` / `nft` /
`attester` / `eip-712` strings — `requestScoreVoucher()` returns early on the build-time-false
literal and Vite drops the whole branch. Skins stay in both builds (palette/cosmetics are game
design, not a crypto concept).

## Layout

```
index.html              # mount + module entry
src/
  config.js             # field/RULES + CRYPTO_BUILD flag + SETTLEMENT config
  main.js               # Phaser game config, scene list
  scenes/
    BootScene.js        # bakes procedural ball/paddle/brick/powerup textures, then -> Menu
    MenuScene.js        # title + palette selector + Play
    PlayScene.js        # the whole game loop, input, juice, game-over + settlement
  data/
    skins.js            # skin catalog loader/normalizer (cosmetic-item shape) + ownership seam
    scoreVoucher.js     # EIP-712 voucher payload + attester POST (crypto build only)
  logic/
    bounce.js           # PURE functions: paddle english, wall/brick collision, HP, scoring, scaling
data/
  skins.fixture.json    # skin definitions (ItemRegistry cosmetic shape, ids 30000+)
test/
  logic.test.mjs        # node --test (24 cases)
```

## Tests

`src/logic/bounce.js` is pure (no Phaser) so it runs under `node --test`: the 8×6 field build
with row HP tiers and non-overlapping tiling, alive-count tracking, paddle-offset english (0 at
centre, ±1 clamped at edges) and the bounce-angle/speed-preservation math, wall reflection +
position clamp, fall-off detection, circle-vs-rect brick collision axis selection (and dead-
brick skip), HP damage/destroy, axis reflection, score scaling by tier/level + clear bonus, the
+10% speed ramp with clamp, velocity rescale, and the powerups (drop chance/type, wide-paddle
cap, multiball split, paddle clamp). Plus the skin-data normalizer (cosmetic-range
enforcement). Run `npm test`.

## Notes / constraints

- One self-contained `npm install` (`phaser`, `vite`) confined to `games/wallbreaker/`.
- Phaser **4.x**; placeholder art only — every texture is drawn to canvas in `BootScene`.
- PUBLIC repo: only the **PRANA** brand appears in shipped strings; no other ecosystem names.
```
