# PRANA Spirit Bop

**Spirit Bop** is a PRANA whack-a-mole reflex game. Spirits pop up from a 3×3 grid of mounds
on a seeded schedule that **accelerates** while the **hit window shrinks** — bop them before
they sink. But a rare **friendly lantern-spirit** also appears: bop it and you take a penalty
and break your combo. Plain JavaScript ES modules, Phaser for rendering, Vite for dev/build,
and **every texture drawn procedurally to canvas** (no binary assets). The game is fully
playable on its own and is wired so finished runs can settle to an on-chain reward voucher —
without the game ever holding a key — via a build flag that is dead-code-eliminated from the
public build.

This mirrors the proven scaffold in `games/naga/` (same dual-build mechanism, same
fixture→chain seam pattern).

## Quick start

```bash
cd games/spirit-bop
npm install        # phaser + vite only (confined to this directory)
npm run dev        # http://localhost:5173 — play it
npm test           # pure-logic unit tests (node --test)
```

## Controls

- **Bop:** tap / click a spirit while it is up.
- A tap on the round-over screen restarts.

## The game

- A **3×3 grid of mounds.** Spirits rise on a **seeded schedule** (`buildSchedule` is pure —
  a given seed reproduces the exact same round).
- **It accelerates:** the spawn interval shrinks from `baseSpawnMs` toward `minSpawnMs` and
  the **hit window** each spirit stays boppable shrinks from `baseWindowMs` toward
  `minWindowMs` as the 60-second round progresses.
- **Spirits** (the angry-eyed wisps) are worth points. **Bop them in time.** A spirit that
  sinks un-bopped breaks your combo (a miss).
- **The lantern-spirit** (warm hue, calm flame, big soft halo) is **friendly — do NOT bop
  it.** Bopping it costs `lanternPenalty` points (clamped at 0) and resets your combo.
- **Combo meter:** consecutive clean bops escalate a bonus (`comboStep` per step, capped at
  `comboCap`). A miss or a lantern slip resets it.
- **Score = base hits + combo bonuses − lantern penalties.**
- **Juice:** spirits rise with a back-ease bounce, hit burst on a clean bop, red mound flash
  on a miss, warm flash + screen-shake on a lantern slip.

### Tuning

All tuning lives in `RULES` in `src/config.js`: `roundMs`, `baseSpawnMs`/`minSpawnMs`,
`baseWindowMs`/`minWindowMs`, `lanternChance`, `hitPoints`, `comboStep`/`comboCap`,
`lanternPenalty`, and the schedule `seed`.

## Skin slots (cosmetics)

`src/data/skins.js` loads a catalog from `data/skins.fixture.json`. Each skin is a spirit
palette + face-shape variant, shaped to **mirror an on-chain cosmetic item** from
`contracts/contracts/ItemRegistry.sol`:

```json
{ "itemId": 30000, "name": "Prana Wisp", "face": "round",
  "palette": { "spirit": "#7fd6ff", "accent": "#bff0ff", "lantern": "#ffd27f" } }
```

- `itemId` **must be ≥ 30000** — ItemRegistry reserves `30_000 .. max` for cosmetics
  (`COSMETIC_MIN` / `COSMETIC_MINTER_ROLE`). The normalizer rejects out-of-range ids.
- `palette.{spirit,accent,lantern}` are `#rrggbb`; `face` is a variant (`round` | `wisp`).
- Skins are selectable in the menu; `BootScene` bakes a procedural spirit + lantern texture
  per skin.

**On-chain ownership gating (documented seam, not yet wired):** the clean build ships every
skin unlocked. With the wallet hook, the (private) wallet workspace will inject the player's
owned cosmetic ids (read from `ItemRegistry.balanceOf(player, itemId)` over RPC) and
`ownedSkins(catalog, ownedIds)` will filter the catalog to held items.

## Settlement rails (crypto build only)

`src/data/scoreVoucher.js` builds the **exact** payload the on-chain reward path expects. The
game **never holds keys and never signs** — at round-over it POSTs the run to a configurable
**attester** endpoint; the server signs an EIP-712 voucher the player later redeems at
`ArcadeFaucet`.

Exact shapes mirrored from `contracts/contracts/ArcadeFaucet.sol`:

- **EIP-712 domain:** `name="ArcadeFaucet"`, `version="1"`.
- **Voucher struct:** `Voucher(address player,uint256 amount,bytes32 scoreRef,uint256 deadline,uint256 nonce)`.
- **Redeem call:** `claim(player, amount, scoreRef, deadline, nonce, signature)` — see
  `toClaimArgs(voucher)` for the exact positional tuple.

`scoreRef` is computed **server-side** as `keccak256(gameId, player, score, runHash)` (the
game ships no hashing/crypto library). The bound `gameId` is **`"spirit-bop"`**. When
`SETTLEMENT.attesterUrl` is null the module returns a **documented fixture voucher**
(`fixtureVoucher`, flagged `fixture:true`, a placeholder signature — not redeemable) so the
round-over flow is demoable offline.

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
    BootScene.js        # bakes procedural mound/spirit/lantern textures, then -> Menu
    MenuScene.js        # title + spirit skin selector + Play
    PlayScene.js        # the whole game loop: schedule, spawns, taps, combos, round-over + settlement
  data/
    skins.js            # skin catalog loader/normalizer (cosmetic-item shape) + ownership seam
    scoreVoucher.js     # EIP-712 voucher payload + attester POST (crypto build only)
  logic/
    bop.js              # PURE functions: seeded schedule, ramps, hit-window check, combo math,
                        #   lantern penalty, scoring state machine (unit-tested)
data/
  skins.fixture.json    # skin definitions (ItemRegistry cosmetic shape, ids 30000+)
test/
  logic.test.mjs        # node --test
```

## Tests

`src/logic/bop.js` is pure (no Phaser) so it runs under `node --test`: seeded RNG
determinism, the spawn-interval and hit-window ramps (shrink + floor clamp), schedule
determinism / well-formedness / acceleration / no same-mound overlap / lantern minority, the
exclusive-edge hit-window check, tap resolution, combo-bonus escalation + cap, the scoring
state machine (hit / lantern-penalty-clamped-at-zero / miss, purity), and `classifyTap`. Plus
the skin-data normalizer (cosmetic-range enforcement). Run `npm test`.

## Notes / constraints

- One self-contained `npm install` (`phaser`, `vite`) confined to `games/spirit-bop/`.
- Phaser **4.x**; placeholder art only — every texture is drawn to canvas in `BootScene`.
- PUBLIC repo: only the **PRANA** brand appears in shipped strings; no other ecosystem names.
```
