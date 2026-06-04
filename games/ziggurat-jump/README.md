# PRANA Ziggurat Jump

**Ziggurat Jump** is the PRANA vertical-hopper arcade game. Your hopper **auto-bounces** off
every ledge it lands on — there's no jump button — and you steer **left/right** (the screen
**wraps** edge to edge) to climb an endless, procedurally laddered temple. Some ledges
**move**, some **crumble** after a single bounce. The camera follows your highest point; your
**score is the height** you reach. Fall below the view and the run ends. Plain JavaScript ES
modules, Phaser for rendering, Vite for dev/build, and **every texture drawn procedurally to
canvas** (no binary assets). Fully playable on its own and wired so finished runs can settle
to an on-chain reward voucher — without the game ever holding a key — via a build flag that is
dead-code-eliminated from the public build.

This mirrors the scaffold in `games/naga/` (same dual-build mechanism, same fixture→chain seam
pattern, same voucher rails).

## Quick start

```bash
cd games/ziggurat-jump
npm install        # phaser + vite only (confined to this directory)
npm run dev        # http://localhost:5173 — play it
npm test           # pure-logic unit tests (node --test)
```

## Controls

- **Steer:** Arrow keys or **A/D** — left/right only. There is **no jump**: landing on a
  ledge while falling auto-bounces you up.
- **Wrap:** exit the right edge and you re-enter on the left (and vice-versa).
- **Touch/tilt:** hold the left or right half of the screen to steer; a tap on the game-over
  screen restarts.

## The game

- The hopper bounces upward off any ledge it lands **on top of while falling** (collision is
  one-way: you pass up through ledges from below).
- Ledges are generated **upward** by a **seeded PRNG** in the logic layer, within a vertical
  gap band, in three flavors:
  - **normal** — solid.
  - **moving** — slides side to side and bounces off the walls.
  - **crumble** — vanishes right after the first bounce (use it and move on).
- The **camera follows your max height**, keeping the hopper ~40% down the screen. **Score =
  height climbed.** Drop below the camera's bottom edge and it's **game over**.
- **Height milestones speed the climb:** every `speedEvery` units, gravity, bounce, and
  platform motion scale up (clamped) — the higher you get, the tenser it is.
- Hoppers leave a fading **bounce trail**; ledges read as stepped ziggurat stone (procedural).

### Tuning

All tuning lives in `RULES` in `src/config.js` (merged over the pure-logic `DEFAULTS` in
`src/logic/hop.js`): gravity, bounce velocity, steer speed, gap band, moving/crumble chances,
platform speed, and the milestone speed-up (`speedEvery` / `speedStep` / `speedMax`).

## Skin slots (cosmetics)

`src/data/skins.js` loads a catalog from `data/skins.fixture.json`. Each skin is a hopper
palette + trail style, shaped to **mirror an on-chain cosmetic item** from
`contracts/contracts/ItemRegistry.sol`:

```json
{ "itemId": 30000, "name": "Lapis Hopper", "trail": "spark",
  "palette": { "body": "#1d3a66", "edge": "#7fbfff", "glow": "#cfe8ff" } }
```

- `itemId` **must be ≥ 30000** — ItemRegistry reserves `30_000 .. max` for cosmetics
  (`COSMETIC_MIN` / `COSMETIC_MINTER_ROLE`). The normalizer rejects out-of-range ids.
- `palette.{body,edge,glow}` are `#rrggbb`; `trail` is a bounce-trail style (`spark` |
  `ribbon`).
- Skins are selectable in the menu; `BootScene` bakes a procedural hopper + trail texture per
  skin.

**On-chain ownership gating (documented seam, not yet wired):** the clean build ships every
skin unlocked. With the wallet hook, the (private) wallet workspace will inject the player's
owned cosmetic ids (read from `ItemRegistry.balanceOf(player, itemId)` over RPC) and
`ownedSkins(catalog, ownedIds)` will filter the catalog to held items.

## Settlement rails (crypto build only)

`src/data/scoreVoucher.js` builds the **exact** payload the on-chain reward path expects. The
game **never holds keys and never signs** — at game-over it POSTs the run to a configurable
**attester** endpoint; the server signs an EIP-712 voucher the player later redeems at
`ArcadeFaucet`.

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

**Verified:** the clean bundle contains **zero** `wallet` / `jsonrpc` / `voucher` / `nft`
strings — `requestScoreVoucher()` returns early on the build-time-false literal and Vite drops
the whole branch. Skins stay in both builds (palette/trails are game design, not crypto).

## Layout

```
index.html              # mount + module entry
src/
  config.js             # world geometry/RULES + CRYPTO_BUILD flag + SETTLEMENT config
  main.js               # Phaser game config, scene list
  scenes/
    BootScene.js        # bakes per-skin hopper/trail + platform textures, then -> Menu
    MenuScene.js        # title + skin-slot selector + Play
    PlayScene.js        # the hopper loop, camera-follow, input, game-over + settlement
  data/
    skins.js            # skin catalog loader/normalizer (cosmetic-item shape) + ownership seam
    scoreVoucher.js     # EIP-712 voucher payload + attester POST (crypto build only)
  logic/
    hop.js              # PURE functions: bounce/gravity, one-way platform collision,
                        #   seeded platform generation, wrap, camera/fall, difficulty (unit-tested)
data/
  skins.fixture.json    # skin definitions (ItemRegistry cosmetic shape, ids 30000+)
test/
  logic.test.mjs        # node --test
```

## Tests

`src/logic/hop.js` is pure (no Phaser) so it runs under `node --test`. Covered: the seeded
PRNG (deterministic), difficulty scaling (clamped), platform generation (gap band, in-bounds,
all three types, monotonic ladder), moving-platform wall bounce, horizontal `wrapX`, one-way
landing detection (downward crossing + overlap, ignores dead/crumbled ledges), player physics
(gravity, auto-bounce only from above, pass-through while rising, crumble consumption, steer
wrap, purity), height/camera/fall math, deterministic `newRun`, pruning, and an integration
sim that actually climbs. Plus the skin-data normalizer (cosmetic-range enforcement). Run
`npm test`.

## Notes / constraints

- One self-contained `npm install` (`phaser`, `vite`) confined to `games/ziggurat-jump/`.
- Phaser **4.x**; placeholder art only — every texture is drawn to canvas in `BootScene`.
- PUBLIC repo: only the **PRANA** brand appears in shipped strings; no other ecosystem names.
```
