# PRANA Mergestone

**Mergestone** is the PRANA 2048-style slide-merge arcade game. A 4×4 board of carved
rune-stones: slide them all one direction, equal stones fuse into the next tier (double
value), a new stone appears, and you keep climbing until the board jams. Plain JavaScript ES
modules, Phaser for rendering, Vite for dev/build, and **every texture drawn procedurally to
canvas** (no binary assets). Fully playable on its own and wired so finished runs can settle
to an on-chain reward voucher — without the game ever holding a key — via a build flag that is
dead-code-eliminated from the public build.

This mirrors the scaffold in `games/naga/` (same dual-build mechanism, same fixture→chain seam
pattern, same voucher rails).

## Quick start

```bash
cd games/mergestone
npm install        # phaser + vite only (confined to this directory)
npm run dev        # http://localhost:5173 — play it
npm test           # pure-logic unit tests (node --test)
```

## Controls

- **Slide:** Arrow keys or **WASD** — all stones slide that direction at once.
- **Swipe:** click/touch and **drag** a direction (dominant axis wins); a tap on the
  game-over screen restarts.
- A direction that changes nothing is ignored (no wasted spawn).

## The game

- A **4×4** board. Each slide pushes every stone to that edge; **two equal stones touching in
  the slide direction merge** into the next tier (value doubles: 2→4→8→16…).
- **Once-per-move rule:** a stone formed by a merge this move can't merge again the same
  move. So `[2,2,2,2]` → `[4,4]` (not `8`), and `[4,2,2]` → `[4,4]` (the leading 4 is
  untouched). No chained collapses in a single slide.
- After a slide that changed the board, a **new stone spawns** in a random empty cell —
  **90% tier 1 (value 2), 10% tier 2 (value 4)** — from a **seeded PRNG** in the logic layer
  (deterministic, fully testable).
- **Score** = the sum of the **values of stones formed by merges** (merging two 4s adds 8).
- **Game over** when no slide in any direction changes the board (board full, no equal
  neighbors).
- **Stone tiers** are carved-rune glyphs that brighten as the tier climbs (lit-from-within
  look), with smooth slide tweens and a spawn pop.

### Tuning

All tuning lives in `RULES` / `BOARD` in `src/config.js`: board size, tile/gap/pad geometry,
the tier-2 spawn chance, and slide/pop tween durations.

## Skin slots (cosmetics)

`src/data/skins.js` loads a catalog from `data/skins.fixture.json`. Each skin is a stone
palette + glyph style, shaped to **mirror an on-chain cosmetic item** from
`contracts/contracts/ItemRegistry.sol`:

```json
{ "itemId": 30000, "name": "Granite Runes", "glyph": "rune",
  "palette": { "stone": "#2a3550", "edge": "#7fa8d6", "glow": "#bfe0ff" } }
```

- `itemId` **must be ≥ 30000** — ItemRegistry reserves `30_000 .. max` for cosmetics
  (`COSMETIC_MIN` / `COSMETIC_MINTER_ROLE`). The normalizer rejects out-of-range ids.
- `palette.{stone,edge,glow}` are `#rrggbb`; `glyph` is a carved-mark style (`rune` |
  `sigil`).
- Skins are selectable in the menu; `BootScene` bakes a procedural carved-stone texture set
  per skin, one per tier.

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
the whole branch. Skins stay in both builds (palette/glyphs are game design, not crypto).

## Layout

```
index.html              # mount + module entry
src/
  config.js             # board geometry/RULES + CRYPTO_BUILD flag + SETTLEMENT config
  main.js               # Phaser game config, scene list
  scenes/
    BootScene.js        # bakes per-skin per-tier procedural carved-stone textures, then -> Menu
    MenuScene.js        # title + skin-slot selector + Play
    PlayScene.js        # the slide/merge loop, slide tweens, input, game-over + settlement
  data/
    skins.js            # skin catalog loader/normalizer (cosmetic-item shape) + ownership seam
    scoreVoucher.js     # EIP-712 voucher payload + attester POST (crypto build only)
  logic/
    merge.js            # PURE functions: slide+merge, once-per-move rule, seeded spawn,
                        #   move-exists/game-over check, seeded PRNG (unit-tested)
data/
  skins.fixture.json    # skin definitions (ItemRegistry cosmetic shape, ids 30000+)
test/
  logic.test.mjs        # node --test
```

## Tests

`src/logic/merge.js` is pure (no Phaser) so it runs under `node --test`. Covered: tier values,
`slideLine` classic edge cases (`[2,2,2,2]→[4,4]`, `[4,2,2]→[4,4]`, no double-merge chains),
the once-per-move lock, directional `move` with change detection and score accumulation,
purity (no input mutation), the seeded PRNG (deterministic, ~90/10 spawn split, null on full
board), and the move-exists / game-over check (empty cell, adjacent-pair, checkerboard
jam). Plus the skin-data normalizer (cosmetic-range enforcement). Run `npm test`.

## Notes / constraints

- One self-contained `npm install` (`phaser`, `vite`) confined to `games/mergestone/`.
- Phaser **4.x**; placeholder art only — every texture is drawn to canvas in `BootScene`.
- PUBLIC repo: only the **PRANA** brand appears in shipped strings; no other ecosystem names.
```
