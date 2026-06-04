# PRANA Tower Defense

A small Phaser tower-defense skeleton. Plain JavaScript ES modules, Vite for dev/build,
procedurally-drawn placeholder art (no binary assets). The game is fully playable on its
own and is wired so tower stats can later come from on-chain NFTs without touching gameplay.

## Quick start

```bash
cd games/tower-defense
npm install        # phaser + vite only (already vendored if node_modules/ exists)
npm run dev        # http://localhost:5173 — play it
npm test           # pure-logic unit tests (node --test)
```

## What the game does

- A fixed 16x12 grid map (2D array fixture) with grass / path / buildable cells.
- Enemies spawn and walk a waypoint path; each has an HP bar.
- Click a buildable cell to place the currently-selected tower (costs gold).
- Towers auto-fire at the nearest enemy in range; projectiles travel, deal damage,
  kill enemies, and pay a gold bounty.
- A lives counter (enemies reaching the end cost a life), a wave counter, and
  per-wave scaling difficulty (more enemies, more HP, faster). Game-over screen with retry.
- Towers are chosen from data definitions whose shape mirrors an NFT trait schema.

## Architecture

```
index.html              # mount + module entry
src/
  config.js             # grid/economy constants + CRYPTO_BUILD flag + CHAIN config
  main.js               # Phaser game config, scene list
  scenes/
    BootScene.js        # draws ALL placeholder textures to canvas, then -> Menu
    MenuScene.js        # title + Play button
    PlayScene.js        # the whole game loop
  data/
    towers.fixture.json # tower definitions (NFT-trait-shaped)
    towers.js           # loads + validates fixture into the canonical shape
    chainLoader.js      # OPTIONAL on-chain loader; always falls back to the fixture
    rarity.js           # rarity buckets/colors + genome->rarity derivation
  logic/
    targeting.js        # PURE functions: targeting, damage, wave scaling (unit-tested)
data/                   # fixture json (imported by towers.js)
test/
  logic.test.mjs        # node --test
```

### Tower data shape (the contract between game and chain)

The game consumes **only** this shape:

```json
{ "tokenId": 0, "name": "Spark Spire", "rarity": "Common",
  "stats": { "damage": 8, "range": 120, "fireRate": 1.4, "level": 1, "xp": 0 } }
```

This mirrors `contracts/contracts/MutableStatNFT.sol`:

| game field        | on-chain source (MutableStatNFT)                                   |
|-------------------|--------------------------------------------------------------------|
| `tokenId`         | ERC-721 token id                                                   |
| `rarity`          | derived off-chain from `genomeOf(tokenId)` (no on-chain enum)      |
| `stats.level`     | `Core.level`                                                       |
| `stats.xp`        | `Core.xp`                                                          |
| `stats.damage`/`range`/`fireRate` | open attribute store `getStat(tokenId, key)`       |

`CreatureNFT.sol` packs everything into one `uint256 traits` word instead; same idea —
rarity and combat stats are decoded off-chain. Because the game never reads anything but
the canonical JSON, swapping fixture → chain is a **loader change only**.

## Dual build (clean vs crypto)

There are two shippable builds, controlled by a single build-time flag `CRYPTO_BUILD`
(see `vite.config.js`, injected as `__CRYPTO_BUILD__`, read in `src/config.js`).

| build  | command            | output       | CRYPTO_BUILD | chainLoader | crypto UI strings |
|--------|--------------------|--------------|--------------|-------------|-------------------|
| clean  | `npm run build:clean`  | `dist-clean/`  | `false` | no-op (fixture only), **dead-code-eliminated** | none |
| crypto | `npm run build:crypto` | `dist-crypto/` | `true`  | active JSON-RPC NFT loader | allowed |

Plain `npm run build` defaults to **clean** (the safest public funnel).

- **Clean build:** the wallet/NFT path is compiled out — verified that the clean bundle
  contains zero `wallet`/`eth_call`/`balanceOf`/`tokenOfOwner`/`jsonrpc`/`nft`/`chainLoader`
  strings. Rarity stays, because it is purely game design, not a crypto concept.
- **Crypto build:** `src/data/chainLoader.js` reads owned tower NFTs over plain JSON-RPC
  (`fetch`, hand-encoded selectors, **no ethers dependency**) and maps them to the same
  canonical tower shape. It **always falls back to the fixture** when the RPC URL / contract /
  owner is unconfigured or the chain is unreachable.

Why this exists: the public clean-funnel build must carry no crypto/NFT/wallet surface,
while the crypto build layers the on-chain integration on top of the identical game.

## Wallet coupling (loose, on purpose)

This game is **read-only** and holds no keys. The signing wallet, key management, and the
"connect wallet" UX live in the separate (private) wallet workspace. That workspace injects
`CHAIN.{ rpcUrl, nftAddress, ownerAddress }` (see `src/config.js`); `chainLoader.js` only
reads public view functions over RPC. The two stay loosely coupled — the game can ship and
run with no chain at all.

## Tests

`src/logic/targeting.js` is pure (no Phaser) so it runs under `node --test`:
nearest-in-range selection, damage math, wave scaling, plus the tower-data normalizer and
the genome→rarity derivation. Run `npm test`.

## Notes / constraints

- One self-contained `npm install` (`phaser`, `vite`) confined to this directory; no other
  package.json/node_modules in the repo was touched.
- Phaser **4.x** is installed (the 3.x API used here — scenes, `make.graphics`,
  `generateTexture`, `add.image/circle/rectangle/text` — is compatible).
- Placeholder art only: every texture is drawn to canvas in `BootScene` — no binary assets.
