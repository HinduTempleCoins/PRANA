# PRANA River Crossing

**River Crossing** is a PRANA frogger-style grid-hopper. Hop one cell at a time across a
gauntlet of traffic lanes and a drifting river to reach the alcoves carved into the far
bank. Plain JavaScript ES modules, Phaser for rendering, Vite for dev/build, and **every
texture drawn procedurally to canvas** (no binary assets). The game is fully playable on its
own and is wired so finished runs can settle to an on-chain reward voucher — without the game
ever holding a key — via a build flag that is dead-code-eliminated from the public build.

This mirrors the proven scaffold in `games/naga/` (same dual-build mechanism, same
fixture→chain seam pattern).

## Quick start

```bash
cd games/river-crossing
npm install        # phaser + vite only (confined to this directory)
npm run dev        # http://localhost:5173 — play it
npm test           # pure-logic unit tests (node --test)
```

## Controls

- **Hop:** Arrow keys or **WASD** — one cell per press, up/down/left/right.
- **Swipe:** click/touch and **drag** a direction (dominant axis wins); a tap on the
  run-over screen restarts.

## The game

- A 13×13 cell board, banks top and bottom with a safe median strip between two bands:
  - **Road band** (lower half): vehicles slide across at varied speeds/directions. Sharing a
    cell with a vehicle is fatal.
  - **River band** (upper half): open water is fatal — you must hop **onto a drifting
    log/reed** and ride it. The river **carries you sideways** with the log; get carried off
    the board edge and you drown.
- The far bank is the **goal row**, carved into **5 alcoves** (each fillable once). Land an
  empty alcove to fill it; hit the wall between alcoves, or an already-filled alcove, and
  you die.
- **Lane patterns are seeded** — a given `(seed, tier)` reproduces the exact same layout
  (`buildBoard` is pure). Higher tiers drift faster and denser.
- **Scoring:** `pointsPerRow` per **net-new** row advanced toward the goal, plus an alcove
  bonus that grows with each alcove already filled this sweep (combo feel). Fill **all 5
  alcoves** for a tier-clear bonus and **+1 difficulty tier** (a fresh, faster field).
- **3 lives** and a **60-second run timer.** Lose all lives or run out of time and the run
  ends.
- **Juice:** hop after-image burst, alcove-fill camera flash, screen shake on death.

### Tuning

All tuning lives in `RULES` in `src/config.js`: `lives`, `runSeconds`, `alcoveCount`,
`pointsPerRow`, `alcoveBase`/`alcoveBonus`, `tierClearBonus`, and the layout `seed`. Grid
size lives in `GRID`.

## Skin slots (cosmetics)

`src/data/skins.js` loads a catalog from `data/skins.fixture.json`. Each skin is a hopper
palette + shape variant, shaped to **mirror an on-chain cosmetic item** from
`contracts/contracts/ItemRegistry.sol`:

```json
{ "itemId": 30000, "name": "Prana Spark", "shape": "round",
  "palette": { "body": "#7fd6ff", "accent": "#bff0ff", "glow": "#1a6fbf" } }
```

- `itemId` **must be ≥ 30000** — ItemRegistry reserves `30_000 .. max` for cosmetics
  (`COSMETIC_MIN` / `COSMETIC_MINTER_ROLE`). The normalizer rejects out-of-range ids.
- `palette.{body,accent,glow}` are `#rrggbb`; `shape` is a variant (`round` | `diamond`).
- Skins are selectable in the menu; `BootScene` bakes a procedural hopper texture per skin.

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
game ships no hashing/crypto library). The bound `gameId` is **`"river-crossing"`**. When
`SETTLEMENT.attesterUrl` is null the module returns a **documented fixture voucher**
(`fixtureVoucher`, flagged `fixture:true`, a placeholder signature — not redeemable) so the
game-over flow is demoable offline.

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
    BootScene.js        # bakes procedural lane/obstacle/hopper textures, then -> Menu
    MenuScene.js        # title + hopper skin selector + Play
    PlayScene.js        # the whole game loop: hop, drift, ride, alcoves, game-over + settlement
  data/
    skins.js            # skin catalog loader/normalizer (cosmetic-item shape) + ownership seam
    scoreVoucher.js     # EIP-712 voucher payload + attester POST (crypto build only)
  logic/
    crossing.js         # PURE functions: seeded lanes, stepping, drift/occupancy, ride-carry,
                        #   fate evaluation, alcove fill, scoring (unit-tested)
data/
  skins.fixture.json    # skin definitions (ItemRegistry cosmetic shape, ids 30000+)
test/
  logic.test.mjs        # node --test
```

## Tests

`src/logic/crossing.js` is pure (no Phaser) so it runs under `node --test`: seeded RNG
determinism, `buildBoard` purity in `(seed, tier)`, board structure (banks/road/water/goal),
tier speed-scaling, drift + wrapped column occupancy, directional obstacle movement, player
stepping/clamping, log-ride carry (drift + swept-off-edge drowning), fate evaluation per lane
kind, alcove fill rules, forward + alcove scoring, the all-filled tier trigger, and an
integration sweep. Plus the skin-data normalizer (cosmetic-range enforcement). Run `npm test`.

## Notes / constraints

- One self-contained `npm install` (`phaser`, `vite`) confined to `games/river-crossing/`.
- Phaser **4.x**; placeholder art only — every texture is drawn to canvas in `BootScene`.
- PUBLIC repo: only the **PRANA** brand appears in shipped strings; no other ecosystem names.
```
