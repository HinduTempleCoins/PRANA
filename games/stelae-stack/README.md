# PRANA Stelae Stack

**Stelae Stack** is the PRANA falling-glyph line-clear stacker. Carved stone glyphs (our
original *stela* set) fall into a 10×20 well; complete a horizontal row to clear it; survive
as gravity ramps. Plain JavaScript ES modules, Phaser for rendering, Vite for dev/build, and
**every texture drawn procedurally to canvas** (no binary assets). The game is fully playable
on its own and is wired so finished runs can settle to an on-chain reward voucher — without
the game ever holding a key — via a build flag that is dead-code-eliminated from the public
build.

This mirrors the proven scaffold in `games/naga/` (same dual-build mechanism, same
fixture→chain seam pattern, same skin-slot cosmetic shape).

## Trade-dress note (read this)

Stelae Stack is a *line-clear stacker* in the broad genre of falling-block puzzlers, but it
**deliberately does not copy the look or pieces of any specific commercial title**:

- **Original piece set.** It ships **five pentomino-flavoured 5-cell glyphs** (Obelisk, Ankh,
  Serpent, Lotus, Falcon) plus **two custom 3-cell "tri-stones"** (Cairn, Shard) — a **seven-
  piece set that is NOT the classic seven 4-cell tetrominoes**. Different cell counts,
  different silhouettes, original names. There is no 4-cell tetromino footprint anywhere
  (a unit test asserts this).
- **Original palette + name.** Egyptian-temple "carved stela" theme (Obelisk/Ankh/Lotus/
  Falcon), PRANA blue/amber/violet palette, chiselled-bevel block art — not the iconic
  primary-colour tetromino palette.
- No trademarked names, logos, sounds, or marketing look-alikes are used.

The shared mechanics (a rectangular well, gravity, rotation, full-row clears, scoring) are
generic genre conventions, not protectable trade dress.

## Quick start

```bash
cd games/stelae-stack
npm install        # phaser + vite only (confined to this directory)
npm run dev        # http://localhost:5173 — play it
npm test           # pure-logic unit tests (node --test)
```

## Controls

- **Move:** ← / →
- **Rotate:** ↑ (or Z / X for CCW / CW)
- **Soft-drop:** ↓ (hold)
- **Hard-drop:** Space (drops to the ghost-preview landing and locks)
- Tap/click on the game-over screen restarts.

## The game

- A **10×20 well**. Stelae fall on a gravity clock; a translucent **ghost** previews the
  hard-drop landing.
- **Rotate** with simplified wall kicks (a small set of horizontal nudges + one up-nudge), so
  rotations against a wall/floor still slot in when there's room.
- A short **lock delay** after a piece lands lets you slide/rotate it before it sets.
- **Clear full rows.** Scoring follows a classic line bonus (1/2/3/4 rows = 100/300/500/800)
  scaled by **level** and by a **combo multiplier** for consecutive clearing drops (`1 + combo
  × 0.5`). A non-clearing drop breaks the combo. Soft/hard drops add small per-cell points.
- **Gentle gravity ramp:** the level rises every **10 cleared lines** and the fall interval
  shortens per level, clamped to a floor so it stays playable.
- **Next-piece preview** in the right gutter.
- **Stack-out:** if a freshly spawned piece can't fit, the run ends.

### Tuning

All tuning lives in `RULES` in `src/config.js`: `linesPerLevel`, `baseGravityMs`,
`gravityPerLevel`, `minGravityMs`, `softDropMs`, and `lockDelayMs`. Grid size lives in `GRID`.

## Skin slots (cosmetics)

`src/data/skins.js` loads a catalog from `data/skins.fixture.json`. Each skin is a **well
palette theme**, shaped to **mirror an on-chain cosmetic item** from
`contracts/contracts/ItemRegistry.sol`:

```json
{ "itemId": 30000, "name": "Temple Night",
  "palette": { "well": "#070b16", "grid": "#152138", "glow": "#bff0ff" } }
```

- `itemId` **must be ≥ 30000** — ItemRegistry reserves `30_000 .. max` for cosmetics
  (`COSMETIC_MIN` / `COSMETIC_MINTER_ROLE`). The normalizer rejects out-of-range ids.
- `palette.{well,grid,glow}` are `#rrggbb`. (Individual stela colours come from the piece
  set in `logic/stack.js` — those are gameplay identity, not a cosmetic.)
- Skins are selectable in the menu; `BootScene` bakes a procedural well tile per skin.

**On-chain ownership gating (documented seam, not yet wired):** the clean build ships every
skin unlocked. With the wallet hook, the (private) wallet workspace will inject the player's
owned cosmetic ids (read from `ItemRegistry.balanceOf(player, itemId)` over RPC) and
`ownedSkins(catalog, ownedIds)` will filter the catalog to held items.

## Settlement rails (crypto build only)

`src/data/scoreVoucher.js` builds the **exact** payload the on-chain reward path expects. The
game **never holds keys and never signs** — at game-over it POSTs the run (`gameId:
"stelae-stack"`) to a configurable **attester** endpoint; the server signs an EIP-712 voucher
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
  config.js             # grid/RULES + CRYPTO_BUILD flag + SETTLEMENT config
  main.js               # Phaser game config, scene list
  scenes/
    BootScene.js        # bakes procedural block + per-skin well textures, then -> Menu
    MenuScene.js        # title + palette selector + Play
    PlayScene.js        # the whole game loop, input, juice, game-over + settlement
  data/
    skins.js            # skin catalog loader/normalizer (cosmetic-item shape) + ownership seam
    scoreVoucher.js     # EIP-712 voucher payload + attester POST (crypto build only)
  logic/
    stack.js            # PURE functions: pieces, rotation, kicks, collision, line-clear, scoring
data/
  skins.fixture.json    # skin definitions (ItemRegistry cosmetic shape, ids 30000+)
test/
  logic.test.mjs        # node --test (31 cases)
```

## Tests

`src/logic/stack.js` is pure (no Phaser) so it runs under `node --test`: the original piece
set's shape (5 pentomino-flavoured + 2 tri-stones, no tetromino footprint), rotation geometry
(4 states, full-turn identity, anchored origin), wall/floor/stack collision, rotation kicks
near walls (and the no-fit null case), movement, hard-drop landing, lock-and-stamp purity,
single/multi/4-row line clears, score scaling by line-count/level/combo, drop scoring, combo
chaining/reset, the level + gravity ramp, spawn centring, deterministic piece selection, and
top-out detection. Plus the skin-data normalizer (cosmetic-range enforcement). Run `npm test`.

## Notes / constraints

- One self-contained `npm install` (`phaser`, `vite`) confined to `games/stelae-stack/`.
- Phaser **4.x**; placeholder art only — every texture is drawn to canvas in `BootScene`.
- PUBLIC repo: only the **PRANA** brand appears in shipped strings; no other ecosystem names.
```
