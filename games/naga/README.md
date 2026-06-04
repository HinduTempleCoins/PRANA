# PRANA Naga

**Naga** is the PRANA Snake arcade flagship. Grid-based serpent, glowing light-orbs, one
life. Plain JavaScript ES modules, Phaser for rendering, Vite for dev/build, and **every
texture drawn procedurally to canvas** (no binary assets). The game is fully playable on its
own and is wired so finished runs can settle to an on-chain reward voucher — without the game
ever holding a key — via a build flag that is dead-code-eliminated from the public build.

This mirrors the proven scaffold in `games/tower-defense/` (same dual-build mechanism, same
fixture→chain seam pattern).

## Quick start

```bash
cd games/naga
npm install        # phaser + vite only (confined to this directory)
npm run dev        # http://localhost:5173 — play it
npm test           # pure-logic unit tests (node --test)
```

## Controls

- **Steer:** Arrow keys or **WASD**.
- **Swipe:** click/touch and **drag** a direction (dominant axis wins); a tap on the
  game-over screen restarts.
- You cannot reverse 180° into your own neck — reversal inputs are rejected.

## The game

- A 24×18 cell grid. A serpent moves one cell per step on a fixed clock.
- Eat the pulsing **light-orb** to grow by one segment. Speed ramps **gently** with length
  (clamped to a floor so it stays playable).
- **One life.** You die on self-collision. Walls are **wrap-around** by default
  (classic-plus); flip `RULES.wrap` to `false` in `src/config.js` for solid-wall mode (a red
  border appears and edge contact ends the run).
- **Score = orbs × multiplier.** The multiplier rises at **length milestones** — one extra
  `×` per 5 segments grown (`RULES.multiplierEvery`).
- **Juice:** orb glow-pulse tween, orb-pop burst on eat, head→tail brightness gradient (dark
  base → luminous head, the dark-field / bright-core motif), and a subtle screen shake on
  death.

### Tuning

All tuning lives in `RULES` in `src/config.js`: grid size, `startLength`, `baseStepMs` /
`minStepMs` / `speedRampPerSegment`, `pointsPerOrb`, `multiplierEvery`, and the `wrap` flag.

## Skin slots (cosmetics)

`src/data/skins.js` loads a catalog from `data/skins.fixture.json`. Each skin is a palette +
head-shape variant, shaped to **mirror an on-chain cosmetic item** from
`contracts/contracts/ItemRegistry.sol`:

```json
{ "itemId": 30000, "name": "Prana Default", "head": "round",
  "palette": { "head": "#7fd6ff", "body": "#0a3a66", "glow": "#bff0ff" } }
```

- `itemId` **must be ≥ 30000** — ItemRegistry reserves `30_000 .. max` for cosmetics
  (`COSMETIC_MIN` / `COSMETIC_MINTER_ROLE`). The normalizer rejects out-of-range ids.
- `palette.{head,body,glow}` are `#rrggbb`; `head` is a shape variant (`round` | `diamond`).
- Skins are selectable in the menu; `BootScene` bakes a procedural texture set per skin.

**On-chain ownership gating (documented seam, not yet wired):** the clean build ships every
skin unlocked. With the wallet hook, the (private) wallet workspace will inject the player's
owned cosmetic ids (read from `ItemRegistry.balanceOf(player, itemId)` over RPC) and
`ownedSkins(catalog, ownedIds)` will filter the catalog to held items.

## Settlement rails (crypto build only)

`src/data/scoreVoucher.js` builds the **exact** payload the on-chain reward path expects. The
game **never holds keys and never signs** — at game-over it POSTs the run to a configurable
**attester** endpoint; the server signs an EIP-712 voucher the player later redeems at
`ArcadeFaucet`.

```
                 ┌──────────────────────────── crypto build only ───────────────────────────┐
   game over     │                                                                            │
  ┌────────┐     │   POST {gameId:"naga", player, score, runHash}                             │
  │ PRANA  │     │            │                                                               │
  │ Naga   │─────┼────────────▼───────────┐         signs EIP-712 Voucher                     │
  │ (run)  │     │     ┌──────────────┐    │   (ATTESTER_ROLE key, server-side)               │
  └────────┘     │     │  attester    │────┘                                                   │
   no keys ──────┼────▶│  endpoint    │  returns { player, amount, scoreRef,                   │
                 │     └──────────────┘            deadline, nonce, signature }                │
                 │            │                                                                │
                 │            ▼  player's wallet workspace redeems                             │
                 │   ArcadeFaucet.claim(player, amount, scoreRef, deadline, nonce, signature)  │
                 └────────────────────────────────────────────────────────────────────────────┘
```

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
strings — `requestScoreVoucher()` returns early on the build-time-false literal and Vite
drops the whole branch. Skins stay in both builds (palette/cosmetics are game design, not a
crypto concept).

## Layout

```
index.html              # mount + module entry
src/
  config.js             # grid/RULES + CRYPTO_BUILD flag + SETTLEMENT config
  main.js               # Phaser game config, scene list
  scenes/
    BootScene.js        # bakes per-skin procedural textures, then -> Menu
    MenuScene.js        # title + skin-slot selector + Play
    PlayScene.js        # the whole game loop, input, juice, game-over + settlement
  data/
    skins.js            # skin catalog loader/normalizer (cosmetic-item shape) + ownership seam
    scoreVoucher.js     # EIP-712 voucher payload + attester POST (crypto build only)
  logic/
    snake.js            # PURE functions: movement, growth, collision, wrap, scoring (unit-tested)
data/
  skins.fixture.json    # skin definitions (ItemRegistry cosmetic shape, ids 30000+)
test/
  logic.test.mjs        # node --test (24 cases)
```

## Tests

`src/logic/snake.js` is pure (no Phaser) so it runs under `node --test`: movement, growth on
eat, self-collision detection, the tail-vacate subtlety (moving into the vacating tail is
legal; eating into a retained tail is fatal), wrap vs solid-wall, 180° reversal rejection,
food spawning (never on the snake, null on a full board), multiplier milestones, and the
speed ramp. Plus the skin-data normalizer (cosmetic-range enforcement). Run `npm test`.

## Notes / constraints

- One self-contained `npm install` (`phaser`, `vite`) confined to `games/naga/`.
- Phaser **4.x**; placeholder art only — every texture is drawn to canvas in `BootScene`.
- PUBLIC repo: only the **PRANA** brand appears in shipped strings; no other ecosystem names.
```
