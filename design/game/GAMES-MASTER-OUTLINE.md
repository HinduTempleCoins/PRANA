# PRANA / SoapBox — Games Master Outline

> The complete consolidation of everything discussed and built about games across the
> project: the on/off-chain boundary, game servers, platform crypto-bans and distribution,
> the precedent games we learned from, NFTs and functional assets, the metaverse / worlds /
> land model, world-building and landscapes, tooling to let people build games on our chains,
> the games we actually built, the economy/anti-cheat design, the IRL bridge, and the launch
> plan. Sourced from the design vault (`design/game/*`, `game-suite-build-map.md`), the
> research notes (O24/O25, heritage), the built contracts/games, and the working sessions.

---

## 0. The Governing Doctrine (the principles every game obeys)

- **One coherent theme, one uniform loop.** Every game shares a single buy → unlock → play →
  earn → sell loop and ONE rarity ladder (Common → Legendary). Not a pile of unrelated games —
  one ecosystem with many front-doors.
- **The chain never renders.** Graphics + moment-to-moment gameplay live client-side (Phaser /
  Godot / Unity / Unreal / WebGL). "Graphics suffering is never a chain problem." The chain only
  ever limits on-chain **throughput, cost, latency** — never visuals.
- **Chain = ownership + economy + settlement. Server = the live session.** Only economically
  meaningful results (mints, item transfers, rewards, match outcomes) touch the chain.
- **Collectible-first, battle-later.** We invert the usual "creatures exist to fight" loop.
- **Original IP only** for creatures/worlds — never a Pokémon (or any other) emulator.
- **Faucet/sink discipline.** Every emission is paired with a drain. "Every faucet needs a drain."
- **Verification-or-it-gets-farmed.** Anything that pays tradeable value must be provable
  (commit-reveal, Merkle fraud-proofs, attester signatures, staking/slashing).
- **Sovereignty over convenience.** Where a platform bans crypto, we ship a clean funnel build and
  keep the real economy on surfaces we own.

---

## 1. The On-Chain / Off-Chain Boundary — "PGL-class" architecture

The defining design question: how much game can live on-chain? The answer is a **four-layer split**
(`design/game/pgl-class-architecture.md`):

- **L1 — Graphics + gameplay: OFF-CHAIN.** Client engine renders and runs the moment-to-moment loop.
- **L2 — Hot game state: a dedicated app-chain / L2.** High-churn real-time economic actions live on a
  side surface so they don't congest PRANA L1. *(This is the biggest UNBUILT piece — see §14.)*
- **L3 — Ownership / economy / settlement: PRANA L1.** Trustless, cheap (staked-energy gas), the
  source of truth for who owns what and who got paid.
- **L4 — Heavy simulation + game AI: the GridCoin / compute river.** Big sims and game AI ride the
  useful-work compute layer — "most chains have no compute layer attached; we do."

**The reference contrast (why this matters):**
- **Splinterlands (Hive)** = light on-chain footprint: card ownership + match *results* recorded;
  gameplay resolved off-chain on **their trusted server**; turn-based, low-frequency. Hive's
  free/fast txs handle it. → "Splinterlands-class."
- **PGL / Prospectors (EOS→WAX)** = heavy on-chain footprint: a real-time economic MMO with many
  players taking continuous on-chain economic actions at once. Needed high-TPS + feeless + low
  latency — "which is why it chose EOS/WAX, and even then it was at the edge." → "PGL-class."
- **The line is transaction volume, not graphics.** Ethereum mainnet (~15–30 TPS, real gas) is bad
  for PGL-class continuous actions — but an EVM contract resolves logic **trustlessly** where Hive
  merely trusts its own server. PRANA reaches PGL-class via cheap gas + the app-chain for hot state
  + the compute layer.
- **Today's contracts support Splinterlands-class.** PGL-class is the north-star the architecture is
  pointed at, not a day-one claim.

---

## 2. Game Servers (the off-chain authoritative layer)

The chain never runs the game server. We researched and slotted the concrete pieces:

- **Colyseus (research note O25) — authoritative real-time multiplayer.** Rooms are the unit of
  isolation (one per session); **only the server mutates room state** (the whole anti-cheat posture);
  clients send messages, server `onMessage` handlers validate + apply; binary delta state-sync at
  ~20fps (Schema/ChangeTree); server game loop via `setSimulationInterval`; scales horizontally over
  Redis. **Wiring:** a room's `onMessage("action")` handler requires an on-chain
  `EnergyStamina.spend()` first — giving live gameplay a TRON-Energy-style economic cost, with the
  stake-boost as "premium throughput." Hosts tower-defense, creature battles, mission resolution;
  only economic results settle on-chain.
- **Nakama (research note O24) — game backend.** Self-hostable Go server (REST + WebSocket + gRPC):
  auth/identity (device, email, Steam, Apple, Google, custom → JWT session; server HTTP key for
  privileged RPC), per-user + shared JSON storage with ACLs, **leaderboards + tournaments** (the
  authoritative score source), matchmaking. **Wiring:** Nakama's after-hooks on leaderboard writes
  sign **EIP-712 vouchers → `ArcadeFaucet.sol`** (the off-chain score source pattern), and feed
  `SeasonPass.sol`.
- **The clean split:** chain = ownership + value sinks; Nakama = realtime + scores + identity;
  Colyseus = the authoritative live loop.
- **Rising Star hybrid (the locked backend pattern):** a normal game server runs moment-to-moment;
  the **mint contract issues tokens/NFTs only on withdrawal/commit**, never every turn — keeping gas
  out of the gameplay loop (Hive-Engine is the reference).
- **AI game servers (the Mineflayer / Mindcraft track):** AI agents run/inhabit game servers; an LLM
  (Qwen/Gemini) plugs into the action/observation loop (Project Sid precedent). Each server = a
  Discord room; agents bridge game↔chat; AI openly labeled. Reach bucket: Minecraft/Rust/ARK/GMod;
  sovereign bucket: Luanti/Veloren/OpenTTD/SS14/Mindustry; skip matchmaking-locked titles.
- **Status:** research + integration specs + the on-chain hooks (EnergyStamina, ArcadeFaucet) are
  built. **No running Colyseus/Nakama instance exists yet** — scoped as "off-chain, no live servers
  yet." A runnable Colyseus/Nakama skeleton (same stub pattern as the pool-coordinator) is the
  natural next buildable piece.

---

## 3. Platform Crypto-Bans & Distribution (the Steam problem)

This is the thread you remembered as "cryptocurrency is banned on some games' servers." It drives the
whole distribution architecture (`design/game/steam-clean-funnel.md`):

- **Steam (Valve):** distribution terms **prohibit apps that use blockchain to exchange
  cryptocurrencies or NFTs** (≈2021 onboarding rule). The store *metadata itself* (page, tags,
  screenshots, EULA) is part of the ToS surface — must also be clean.
- **Epic Games Store:** explicitly **allows** blockchain games (with disclosure + age rating) — but
  not via Epic's own payment rails (our wallet/website handles the crypto tx).
- **itch.io:** permissive — full crypto allowed.
- **Apple App Store / Google Play:** restrictive on crypto/NFT → web / Akasha is the primary surface
  (no app-store gating).
- **Minecraft (Mojang, 2022):** bans blockchain in client/server AND bans Minecraft content on
  blockchain; EULA forbids real-world-value in-game currency → Minecraft Paper server is a
  **non-crypto cosmetic funnel only.**

**The solution — "The Six Dragons" dual-build model (built as EE4):** ONE codebase, two builds from a
compile-time flag.
- `__CRYPTO_BUILD__` is inlined at build time (`vite.config.js`, `--mode crypto|clean`); the bundler
  **dead-code-eliminates** the entire chain loader / wallet / NFT branch from `dist-clean/`.
- **Steam build (`dist-clean`):** full playable game; cosmetic rarity is purely visual; local saves;
  Steam-native fiat cosmetics OK; **zero** wallet / RPC / NFT strings ("mint", "on-chain",
  "tradeable") / token branding / crypto words anywhere, including store metadata. Clean is the
  fail-safe default.
- **Crypto build (`dist-crypto`):** ships to Epic + itch.io + web + Akasha; wallet, NFTs, marketplace,
  in-app settlement.
- **ToS-safe bridge-out:** the clean build links to an external website we control (normal
  marketing) — never an in-app crypto exchange (the **GTarcade off-app-funnel** pattern). It never
  says "claim your tokens."
- **Verified:** `games/tower-defense/` already has the live dual-build scaffold (two output dirs, no
  forked codebase).

---

## 4. Precedent Games & The Lessons We Took

| Precedent | What it is | The lesson / pattern we took |
|---|---|---|
| **CryptoKitties** | First NFT collectible (2017); breeding generates supply | Breeding-NFT mechanics (→ CreatureNFT/CreatureBreeding); the **congestion lesson** — mass on-chain games need the L2/off-chain split. "CryptoKitties-type, original IP — never a Pokémon emulator." Build step #2 = a CryptoKitties-clone + first NFT contracts + royalty marketplace. |
| **Splinterlands** (Hive) | P2E battle-card game; open asset market; land expansion | Tower-defense launch (Soulkeep proves it's on-stack); open asset market (speculators can hold); productive-land reference; land-as-doorway earns from traffic, not flipping. |
| **PGL / Prospectors** (EOS→WAX) | Real-time economic MMO; productive land + labor market | The "PGL-class" bar; ~10-min-per-plot real-time walking cadence; workers/NPCs as hireable/rentable doorways; supply-anchored land. |
| **WAX / AtomicAssets** | Functional-NFT standard (schemas/templates/**mutable stats**) | "Assets that DO things, not just JPEGs." → `MutableStatNFT` (role-gated post-mint stat changes). A primary tooling target. |
| **Holozing** (Hive) | Original-IP creature collector | Legal proof a creature game works without infringing Nintendo; we **differentiate by inverting the loop** (collectible-first). |
| **Infinity Kingdom** | Mobile reward-curve game | "Well of Time" reward curve → `CitizenMissionPath`: first-clear pays big, replays a fraction, daily caps spread engagement. |
| **RuneScape** | MMORPG; Grand Exchange + Bonds | Order-book offer-matching trading; the **Bond** = burnable, tradeable access token (decouples who-pays from who-uses); recipe-crafting as the economy. |
| **NeoPets / Gaia / Kongregate** | 2000s browser games w/ cosmetic markets | "Marketplace royalties = Steam Community Market reborn" — secondary-trade royalties as core revenue (5%/500bps norm). |
| **dCrops** | Seasonal NFT-seed farming | → `SeasonalFarm`: 4×15-day seasons, season-matched non-perishable seed cards, cooldowns, harvest-share pool split. |
| **TerraCore / SCRAP** | Failed economy (faucet, no drain) | The three-legged rule: **emit → redistribute → sink.** Every faucet needs a drain. |
| **V-Bucks** | Closed-currency monetization funnel | The ANTI-model — avoid closed currencies; enable a multi-directional recipe/crafting web. |
| **Enjin (ENJ)** | Game-NFT item economy | Item-economy infra → ItemRegistry (ERC-1155) / GachaMint / RecipeCrafting. |
| **Counterparty (XCP)** | First on-chain NFT issuance (Bitcoin) | Historical NFT plumbing reference. |
| **BAT (Brave)** | Attention token, ad-funded rewards | Advertiser-fiat-funded faucet → ArcadeFaucet / offerwall = the one externally-funded faucet. |
| **GTarcade** | Off-app web-store funnel | Route value off the app store → the Steam bridge-out pattern. |
| **Decentraland / The Sandbox** | Land-speculation metaverses | The ANTI-model — the "empty Decentraland trap"; our land earns from **traffic/residency**, not speculation. |

---

## 5. NFTs & Functional Assets

- **The WAX functional-asset philosophy is the north star:** NFTs that *do things* (stats, utility,
  access) — not static JPEGs.
- **Standards used:** OpenZeppelin ERC-721 / ERC-1155, thirdweb, AtomicAssets-style schemas.
- **`MutableStatNFT`** — ERC-721 with an immutable genome set at mint + a packed mutable Core
  (level/xp/wear/equipped) + an open per-token attribute store, all **role-gated** so any number of
  games can persistently mutate the same token (one creature usable across the whole suite).
- **Breeding (CryptoKitties-lineage):** `CreatureNFT` + `CreatureBreeding` (commit-reveal breed with a
  fee-burn sink). **Open issue flagged:** a free breed path (cooldown-only) is an unpaired faucet that
  threatens scarcity — recommend disabling in prod and routing all breeding through the fee-burn path;
  plus a bred-traits fragmentation bug (true traits live in `CreatureBreeding.childTraits`, not the NFT).
- **Cosmetics:** `GameSkinNFT` wires ERC-721 skins (palette + shape variants) into the arcade games;
  each game mirrors on-chain skin items.

---

## 6. Metaverse / Worlds / Land (the "populated portal-world")

We explicitly reject the Decentraland speculation trap and build a **lived-in portal world**:

- **Land as doorways, not flips (`LandPortalRegistry`):** an owner points a parcel at an
  admin-approved destination; a trusted oracle posts per-parcel traffic per epoch; rewards split
  pro-rata to traffic. Land earns from **traffic/residency**, fixing the empty-Decentraland problem.
- **HUD = owned-character roster = NPC doorways:** the central hub is your roster of owned characters;
  each character is a diegetic loader that checks an on-chain gate and **speaks failed gates as lore,
  never as errors** (the "mysterious shop" model). Hidden doorways form a Crypt-ology ARG discovery
  layer. (`NPCDoorwayRegistry` — composite AND-gating: OWNS_NFT / MIN_STAT / HOLDS_TOKEN /
  REVEALED_SET.)
- **Walking / missions (`CitizenMissionPath`):** one citizen-character per player on a shared map;
  real-time walking (~10 min/plot, PGL cadence); place-node missions to rank up; Infinity-Kingdom
  "Well of Time" reward curve.
- **Scouts + the Monument lore-puzzle (the narrative keystone):** passive clue-gated scouts
  (`ScoutDiscovery`) reveal map + hidden doorways on a cadence; fragment NFTs (soulbound) assemble in
  a **Monument** (`MonumentFragmentRegistry`) that unlocks the project's narrative corpus, with Hathor
  narrating.
- **Worlds are authored scenes, not live 3D:** backdrops authored via the world-design app; Hathor
  generates world content as video / static scenes — no live-render trap.

---

## 7. World-Building, Landscapes & Voxel Worlds

- **Luanti (ex-Minetest) is the sovereign voxel world** (`design/game/luanti-economy-mod.md`): LGPL
  core, Lua mods, own the whole stack, attach any economy incl. crypto/NFTs. AI world-gen is
  unrestricted and ties to the Hathor world pipeline (`place_schematic` / `register_on_generated`).
  Economy via the **Rising-Star hybrid**: in-world play → commit-station debits → server-attested
  signed claim → a bridge daemon settles on-chain through a SessionKeyGrant-scoped key.
- **Minecraft is a cosmetic funnel only** (Mojang bans blockchain) — Paper server, no real-value
  currency; Luanti carries the actual economy.
- **Map/landscape tooling:** Tiled + Phaser/Godot for authored 2D/2.5D maps; Godot for the
  creature-collector and HUD; the character factory (locked style system → over-generate-and-cull) for
  150+ original-IP creatures/characters.
- **Open trust question (gated):** the Luanti server-attested claim makes the world server a trusted
  minter — needs sign-off vs. a heavier player-signed/trustless claim path.

---

## 8. Tooling — Letting People Build Games On Our Chains

The "help people make games / build their game on our blockchain" thread:

- **The GameTable engine is itself the reuse substrate.** One audited on-chain engine (lobby, stake
  escrow, turn rotation, deadlines/timeouts, draw offers, rake) hosts *any* turn-based game via a
  pluggable `IGameRules` interface — a third party ships only a stateless rules contract and gets
  matchmaking + wagering + anti-grief for free.
- **Horizon — a ComfyUI-style visual builder** for value/relationships (the no-/low-code node builder
  direction; spec'd in the Build-Interop docs as the Tier-3 NFT/contract builder).
- **A thirdweb-style SDK for game devs** — drop-in contracts + client libs so a dev wires NFTs,
  items, gacha, marketplaces, and the ArcadeFaucet voucher rail without writing Solidity.
- **The deploy-wizard** (in Akasha) already factory-deploys token/NFT collections + emits verify
  payloads — the Tier-1 backend of that ladder.
- **Distribution-as-a-service:** the dual-build pipeline (clean vs crypto) is reusable by any game on
  the chain that needs a Steam funnel.
- *(Status: the engine + deploy-wizard are built; Horizon + the full game-dev SDK are spec'd, not yet
  built.)*

---

## 9. The Games We Actually Built

**On-chain board games — `GameTable` engine + `IGameRules` + 12 rules contracts:**
- Engine: `GameTable.sol` (shared staked turn engine) + `IGameRules.sol` (stateless rules interface;
  `simultaneous()` flag drives commit-reveal phases; extra-turn games encode the whole streak in one
  move).
- Triad (tic-tac-toe), Four Falls (connect-four), Clash (commit-reveal RPS best-of-N), **Harbor Hunt**
  (battleship — Merkle-committed fleet + fraud-forfeit), Crowns (checkers, mandatory capture/multijump),
  Last Ember (misère Nim), Seed Sower (mancala/Kalah), Claimstakes (dots-and-boxes), **Glyph Guess**
  (hangman — Merkle word + fraud-forfeit), **Echo Match** (memory vs Merkle deck), **Oracle Draw**
  (hi-lo vs committed deck, dup detection), **Reliquary Sweep** (minesweeper vs committed layout,
  cash-out anytime). Hidden-info games use **Merkle-committed boards + fraud-forfeit** (lie → lose the pot).

**Arcade rails:** `ArcadeLeaderboard` (seasonal attester-signed boards + prize pools), `ArcadeFaucet`
(EIP-712 voucher, cooldown + daily caps, pays from a **pre-funded** pool, not a minter), `EnergyStamina`
(per-game regenerating action budget + stake boost).

**Game-suite world contracts:** `MutableStatNFT`, `LandPortalRegistry`, `MonumentFragmentRegistry`,
`ScoutDiscovery`, `CitizenMissionPath`, `NPCDoorwayRegistry`, `PhysicalCardRedemption`,
`GeominingSettlement`, plus `GameHub` (on-chain module registry so the front-end enumerates the whole
suite and modules upgrade without client redeploy).

**Off-chain playable games (`games/`, all dual-build):** 13 Phaser arcade games — flagships **Naga**
(Snake) and **Ley Rider** (Line Rider; player-drawn tracks hash to on-chain track IDs) — plus Stelae
Stack (Tetris), Wallbreaker (Breakout), Temple Volley (Pong), Ibis Flight (Flappy), Void Shards
(Asteroids), Sky Sentinels (fixed-shooter), Mergestone (2048), Ziggurat Jump (hopper), River Crossing
(Frogger), Spirit Bop (whack-a-mole) — and the **Tower Defense** (16×12 grid, towers' data schema
mirrors NFT traits, optional on-chain loader with fixture fallback).

**All renamed to original brands** ("rebrand them so they are ours"), all with logic tests, all
verified dead-code-eliminated in the clean build.

---

## 10. Economy & Anti-Cheat

- **Faucet↔sink, the three-legged rule** (`design/game/economy-balance.md`): every emission paired
  with a drain — Gacha pull → NFT + fee-burn; Farm harvest → re-plant/craft burns; Arcade/Mission/
  Traffic/Season rewards → **pre-funded** (never minted), with per-player + global daily caps; Recipe
  craft burns inputs first; Scout fragments are soulbound (inert in market). The one flagged unpaired
  faucet is the free breed path → disable in prod.
- **"No printer funds rewards."** Faucet solvency comes from real fee/treasury flow (FeeRouter /
  RoyaltyMarketplace proceeds) or advertiser fiat (offerwall) — never a fresh mint.
- **Royalties as core revenue:** EIP-2981 at ~5% on every secondary sale (Steam-Community-Market-reborn).
- **Offerwall = the one externally-funded faucet:** advertiser fiat backs native payouts (Tapjoy /
  AdGem / ironSource / AppLovin / Pollfish) — with anti-fraud/Sybil + MSB/money-transmitter care flagged.
- **Anti-cheat:** server-authoritative state (Colyseus); commit-reveal + Merkle fraud-proofs for
  hidden-info on-chain games; attester signatures + staking/slashing for scores and geo-claims;
  EnergyStamina rate-limiting as an economic throttle.

---

## 11. The Physical / IRL Bridge

- **`PhysicalCardRedemption`** — NFC/QR cards: admin pre-registers `keccak256(serial+secret)`
  commitments; a holder redeems once for a token transfer or NFT mint (the printed-card → digital-asset
  bridge, via a printing partner).
- **`GeominingSettlement`** — location claims via attester-signed EIP-712 geo-vouchers (COIN/XYO
  model): per-cell cooldown + per-epoch cap, optional attestor-stake for slashing, pays from a
  pre-funded pool. GPS-spoofing defense is explicitly off-chain (not the chain's job).
- *(Forward note: card-linked debit/spend would later need a licensed BIN-sponsor + KYC/AML — out of
  scope now.)*

---

## 12. Launch Plan & Build Sequence

1. **Tower Defense first** (one polished game; Splinterlands Soulkeep proves it's on-stack; towers =
   character NFTs, upgrades = gacha).
2. **CryptoKitties-clone** + first NFT contracts + on-chain-royalty marketplace.
3. **Akasha wallet** + mint-on-commit backend.
4. **Creature-collector** via the character factory (original-IP bestiary), collectible-first.
5. **HUD reveal as an "easter egg"** — the TD towers + creatures become the roster; NPC doorways,
   walking path, scouts, Monument lore turn on.
6. **Arcade pack** (the 13 Phaser games) wired to the offerwall faucet.
7. **Economy balance pass** (emission vs sinks; seasons clock).
8. **Distribution:** Steam clean + Epic/itch/web crypto + Luanti sovereign world + Minecraft cosmetic.
9. **Physical:** NFC/QR cards + geomining devices.

---

## 13. Status — Built vs. Not Built

**Built + tested (on-chain):** GameTable + 12 board games, ArcadeLeaderboard/ArcadeFaucet/
EnergyStamina, the 8 world contracts + GameHub, MutableStatNFT, CreatureNFT/Breeding, SeasonalFarm,
GachaMint(OnCommit), ItemRegistry, RecipeCrafting, SeasonPass.
**Built (off-chain):** 13 Phaser arcade games + Tower Defense, dual-build pipeline, NFT-trait→tower
binding, fixture-fallback wallet hook.
**Spec'd, not built:** Colyseus + Nakama running servers; the app-chain/L2 for hot state; Horizon
visual builder + the game-dev SDK; the Luanti economy mod (running); AI game-server agents.

---

## 14. Open Questions / Gated Decisions

- **App-chain vs L2 for hot game state** — the biggest unbuilt architectural piece for PGL-class.
- **Heavy sim routing** — verified compute river vs. a trusted game server.
- **Luanti claim trust model** — server-attested (trusted minter) vs. player-signed/trustless.
- **Free breed path** — disable in prod (recommended) and route all breeding through the fee-burn sink.
- **PGL-class timing** — near-term build vs. north-star (today = Splinterlands-class).
- **Offerwall compliance** — anti-Sybil + MSB/money-transmitter framing before the ad-funded faucet
  goes live.

---

*Source docs: `design/game/pgl-class-architecture.md`, `design/game/CONTRACTS.md`, the private vault's
`game-suite-build-map.md` / `steam-clean-funnel.md` / `luanti-economy-mod.md` / `character-factory.md`
/ `economy-balance.md`, research notes O24 (Nakama) + O25 (Colyseus), and the built `contracts/contracts/games/*`
+ `games/*`.*
