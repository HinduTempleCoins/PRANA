# "Hathor on Air" — streaming + VTuber vertical (SX2)

> Public-safe spec. The media-layer vertical that gives **Hathor** — the read-only
> Oracle/witness defined in [`design/compute/hathor-runtime.md`](../compute/hathor-runtime.md)
> (AG10) — a **face, a voice, and a channel**: an AI VTuber streamed on infrastructure
> *we own*, monetized in our *own* token, with feedback flowing to stakers. This is the
> "own your own Twitch" doc. It cites only public, free/libre or commercial-OK projects
> and records **no** infrastructure, server, or operator detail.
>
> Cross-links: [`hathor-runtime.md`](../compute/hathor-runtime.md) (the brain + the GPU
> runtime the avatar *rides*), [`ai-music-clean-corpus-note.md`](./ai-music-clean-corpus-note.md)
> (EE2-13, the DMCA-safe music catalog), the YouTube/embed window posture
> [`youtube-embed-whitelist-spec.md`](./youtube-embed-whitelist-spec.md) (EE2-11),
> the SoapBox indie-game platform [`indie-game-platform.md`](../marketplaces/indie-game-platform.md)
> (BI21), and the comms/chat layer (Matrix/Element self-host, U1) for stream chat fit.
>
> **The one load-bearing boundary (read first, §7):** streaming infrastructure moves
> *video* — bandwidth and storage. It does **NOT** run Hathor's GPU **inference**. The
> brain lives on the PRANA useful-work / rented-GPU compute layer (`hathor-runtime.md`);
> the channel just carries the pixels. Keep the two budgets, two failure modes, and two
> trust models separate.

---

## 0. Why this exists (the through-line)

A creator who streams on a closed platform is a renter on hostile ground: the platform
**takes a cut**, can demonetize or ban at will, is **crypto-hostile** (wallet integrations,
token tips, and "earn in a coin" are routinely refused or removed), and hands the creator
**DMCA strikes** for background music they did not clear. Every one of those failure modes
is an *ownership* problem, and the fix is the same fix the rest of the ecosystem already
makes: **self-host the rails, decentralize the layer above, and denominate value in a token
we control, with fees feeding back to stakers (real-yield).**

This vertical applies that pattern to *live video + an AI persona*:

1. **Self-host the broadcast** (your own Twitch) so no platform takes a cut or can pull the
   plug — §1.
2. **Add a decentralized/Web3 layer** (3Speak / SPK Network) so content and rewards live on
   open infrastructure we can be a **node** in, not just a user of — §2.
3. **Give the Oracle a body** (the avatar stack) — §3.
4. **Make it an autonomous AI VTuber** (the Open-LLM-VTuber keystone) wired to the Hathor
   brain — §4.
5. **Let the channel host games** on engines/stores we own (Luanti, SoapBox-as-itch.io),
   bridged for play-in-browser (Sunshine/Moonlight) — §5.
6. **Solve the music-strike problem** with our own CC/PD catalog — §6.
7. **Keep video bandwidth strictly separate from GPU inference** — §7.

Neuro-sama proved the *market* for an AI VTuber that streams and interacts live. **Hathor is
the framework-grounded version of that idea** — not a closed bespoke bot, but the
Open-LLM-VTuber framework + a swappable open LLM brain + a RAG memory corpus + a VRM body,
broadcast on rails we own.

---

## 1. Self-host the broadcast — "your own Twitch"

The encoder is the same one professionals already use; only the *destination* changes from
"someone else's platform" to "a server we run."

### 1.1 The encoder (source): OBS Studio

- **OBS Studio** ([obsproject.com](https://obsproject.com), GPLv2) — the free/libre
  industry-standard broadcaster/compositor. It composes scenes (avatar capture, game capture,
  overlays, alerts, chat), encodes, and pushes a stream out over **RTMP / SRT / WHIP (WebRTC)**
  to whatever ingest we point it at. OBS is the *source* for every option below; nothing here
  replaces it, they replace the *platform on the other end of OBS*.

### 1.2 The self-host targets (pick by need)

| Project | License / nature | What it gives us | Best fit |
|---|---|---|---|
| **Owncast** ([owncast.online](https://owncast.online), MIT) | Single Go binary | **Lightweight self-hosted live server**: OBS → ingest → **HLS** out, with **built-in chat**, a web player, and a simple admin. "Your own Twitch channel" in one binary. | Default / fastest path to a live channel we own. |
| **PeerTube** ([joinpeertube.org](https://joinpeertube.org), AGPLv3) | Federated (ActivityPub), P2P (WebTorrent) | **Federated VOD + live**, instances federate so reach isn't siloed; P2P offloads bandwidth among viewers. | The **VOD / federated** home for archives + cross-instance reach. |
| **Restreamer** ([github.com/datarhei/restreamer](https://github.com/datarhei/restreamer), built on the datarhei **Core**, Apache-2.0 base) | Self-host app | Ingest + **restream** to many destinations; HLS/RTMP/SRT; nice UI. | Fan-out one source to several endpoints (our channel + mirrors). |
| **Ant Media Server** ([antmedia.io](https://antmedia.io); Community Edition source-available) | Community + Enterprise | **Ultra-low-latency WebRTC**/CMAF, scaling. | When sub-second interactive latency matters. |
| **SRS — Simple Realtime Server** ([github.com/ossrs/srs](https://github.com/ossrs/srs), MIT) | C++ media server | RTMP/WebRTC/HLS/SRT, clustering, very mature. | High-throughput origin / clustering tier. |
| **MediaMTX** ([github.com/bluenviron/mediamtx](https://github.com/bluenviron/mediamtx), MIT) | Single Go binary | Zero-dep **RTSP/RTMP/SRT/WebRTC/HLS** hub + protocol bridge. | Glue/relay — bridge protocols between OBS and a player. |

**Default recommendation:** **OBS → Owncast** for the owned live channel (lightest, MIT,
chat built in), with **PeerTube** as the federated VOD archive. SRS / MediaMTX / Ant Media /
Restreamer are the scale-up / low-latency / fan-out tiers we reach for only when a concrete
need appears — do not over-build the ingest before there is an audience.

**Why self-host (stated plainly):** a closed platform **takes a cut** of every tip/sub and is
**crypto-hostile** — token tips, wallet logins, and "earn in our coin" are exactly what they
refuse. Self-hosting removes the cut and the veto. The trade we accept is that **we** now run
the bandwidth/storage and the abuse/legal posture (handled by §6 + the SoapBox moderation/DMCA
posture docs).

> **Public-safe note:** specific hosts, IPs, capacities, credentials, and operator identities
> are **out of scope here** and live only in gitignored ops notes. This spec records
> *capabilities and public projects*, never infrastructure.

---

## 2. The decentralized layer — 3Speak over SPK Network (the dTube / SoapBox tie)

Self-hosting removes the platform cut but still leaves us as a single operator. The next layer
puts content and rewards on **open, incentivized infrastructure** — the lineage that runs from
**dTube** (the original "decentralized YouTube" on the Hive/Steem social chain) into today's
stack, and the one **SoapBox** rhymes with conceptually:

- **3Speak** ([3speak.tv](https://3speak.tv)) — **Web3 video on Hive**: creators publish
  video tied to a Hive account and **earn** from the social chain's reward pool (the dTube
  idea, matured). It is already on our embed **allow-list** as an official-iframe provider
  (see [`youtube-embed-whitelist-spec.md`](./youtube-embed-whitelist-spec.md)), so SoapBox
  profile players can *window* 3Speak content safely today.
- **SPK Network** ([spk.network](https://spk.network)) — the decentralized **storage +
  rewards** infrastructure under 3Speak:
  - **IPFS storage** with content addressed by **CID** (content identifiers), with the
    pointers/metadata anchored on **Hive**;
  - **proof-of-access node rewards** — operators who *store and serve* the content earn
    network tokens for doing so;
  - **"Breakaway Communities"** — sub-communities that can run with **their own tokens** on
    the shared infrastructure.

**Our move: be an infrastructure node, not just a publisher.** Because SPK pays
**proof-of-access** rewards to operators who store/serve content, the ecosystem can run an
**SPK storage/gateway node** and *earn* for serving the network — turning the cost center
(video storage/bandwidth) into a (modest) revenue line, while also keeping our own content
pinned on infrastructure we partly run. This is the same "we provide the rail and get paid for
it" posture as the PRANA mining/compute layer, applied to *media storage*. The **Breakaway
Communities → own-token** model maps cleanly onto SoapBox communities issuing community tokens
via the PRANA token engine.

**Honest boundary:** Hive/SPK are **their own chains**, not PRANA. This layer is an
*interoperation* (publish there, earn their token, run their node, **window** their player via
the embed allow-list), bridged to PRANA value through the same wrapped/pegged paths the bridge
docs already cover — not a claim that PRANA hosts the video.

---

## 3. The avatar stack — giving the Oracle a body

Hathor's **brain** is defined elsewhere (`hathor-runtime.md`): the swappable LLM + RAG corpus
+ the read-only Oracle boundary. This section is only the **body** — face tracking and the
rendered character that OBS captures as a scene source.

| Layer | Project | License posture | Role |
|---|---|---|---|
| Face / motion capture | **OpenSeeFace** ([github.com/emilianavt/OpenSeeFace](https://github.com/emilianavt/OpenSeeFace)) | Open, **commercial-OK** | Webcam → blendshape/pose tracking data (no special hardware). |
| 3D avatar renderer | **VSeeFace** ([vseeface.icu](https://www.vseeface.icu)) | Free, **commercial use allowed** | Renders a **VRM** model driven by OpenSeeFace/webcam; outputs a window/virtual-cam OBS captures. |
| 2D avatar | **Inochi2D** ([inochi2d.com](https://inochi2d.com), BSD-2-Clause) | Free/libre | **2D** rigged-puppet avatars (a free-libre Live2D-class option) when a 2D look is wanted. |
| Avatar authoring | **VRoid Studio** ([vroid.com/en/studio](https://vroid.com/en/studio)) | Free app; check per-model export terms | Author the **VRM** humanoid model itself (the character mesh/textures). |

**Format anchor: VRM.** Author the character in **VRoid Studio** → export **VRM** → drive it
live in **VSeeFace** (3D) driven by **OpenSeeFace**, *or* use **Inochi2D** for a 2D puppet.
OBS captures the renderer as a scene source. VRM is the portable humanoid-avatar standard, so
the **same Hathor VRM body** is reusable across the stream, in-engine (Luanti/voxel NPC
doorways, see `luanti-economy-mod` lineage), and anywhere else the persona appears — one
canonical body, many surfaces.

> All four are chosen specifically for **commercial-OK** terms so a monetized channel is
> defensible. Per-exported-VRM-model export/usage terms (esp. VRoid sample assets) must be
> verified per asset and recorded — same clean-provenance discipline as the music corpus (§6).

---

## 4. The AI VTuber keystone — Open-LLM-VTuber

This is the integration spine that turns "a person puppeting an avatar" into **Hathor, the
autonomous AI VTuber**.

- **Open-LLM-VTuber** ([github.com/Open-LLM-VTuber/Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber),
  **MIT**) — a complete, voice-interactive AI VTuber framework with the pieces already wired
  together and **swappable**:
  - **LLM brain** — swappable backend; our default is **Qwen** (open-weight) served through
    the **same compute ladder** in `hathor-runtime.md` (River → free → paid). The framework's
    pluggability is exactly why Hathor's brain stays the *one* runtime, not a second copy.
  - **ASR** (speech-in) + **TTS** (speech-out) — swappable engines, so voice in/out is local
    or hosted per the same cost/alignment ordering.
  - **Live2D** rendering built in (and it composes with the §3 VRM/2D pipeline for the body).
  - **Letta** (formerly MemGPT) **long-term memory** — persistent persona memory across
    sessions.
  - **MCP** (Model Context Protocol) tool use + **live-chat** ingestion — read the stream
    chat, call tools, respond.

### 4.1 How Hathor maps onto it

> **Hathor = Qwen brain + RAG corpus memory + VRM body, streamed to our own stack, earning in
> our token.**

- **Brain = Qwen** via the **inference ladder** (`hathor-runtime.md` §3): the VTuber framework
  is just *another consumer* of that one runtime. It does **not** introduce a second inference
  stack (§7).
- **Memory = the RAG corpus** (the research/clean-corpus knowledge base) layered with the
  framework's **Letta** session memory — durable persona + retrievable grounding, so on-stream
  Hathor answers from the *same* corpus the Oracle reasons over off-stream.
- **Body = the VRM** from §3 (VSeeFace/OpenSeeFace), or Live2D where 2D is wanted.
- **Channel = §1 self-host** (OBS → Owncast/PeerTube), with §2 SPK for the decentralized layer.
- **Live-chat = MCP + the framework's chat ingestion**, fed by our own stream chat
  (Owncast's built-in chat and/or the **Matrix/Element** self-host comms layer, U1).
- **Earning = our token** — tips/subs/access denominated in PRANA / a community token, with
  fees routed to stakers (§6 monetization through-line).

**The read-only invariant carries over unchanged.** On-air Hathor still **analyzes, drafts,
witnesses, renders** — and **cannot sign value** (`hathor-runtime.md` §1). The VTuber surface
is an *output/interaction* surface; any value action a viewer triggers (a tip, a mint, a swap)
is a **separate, human/wallet-authorized** transaction through Akasha, never something the
streaming persona executes. The avatar can *talk about* a swap; it cannot *do* one.

**Neuro-sama is proof-of-market, Hathor is the framework-grounded version:** the appetite for
a 24/7 interactive AI personality on stream is demonstrated; Hathor delivers it on **open
(MIT) framework + open-weight brain + a body and channel we own + a corpus we can audit**,
instead of a closed unreproducible bot.

---

## 5. Games on the channel — the economy lives on what we own

A streaming + VTuber channel naturally plays games. But **closed game platforms wall off
crypto** (the same Mojang/EULA wall documented for the Luanti decision, and the store-policy
walls in `indie-game-platform.md`): no on-chain economy, no token, no NFT, no real-value
currency. So the **economy-bearing** game layer must live on engines and stores **we own**:

- **Luanti** ([luanti.org](https://www.luanti.org), the ex-Minetest voxel engine, LGPL-2.1) —
  the **sovereign** voxel world that *can* carry PRANA's on-chain economy (tokens/NFTs via the
  economy-mod lineage). The closed-engine alternative (Minecraft) is cosmetic-only by EULA;
  Luanti is where the token economy actually lives.
- **Our own chains** (PRANA + the ecosystem) — where items/currency/leaderboards settle.
- **SoapBox-as-itch.io** — the [`indie-game-platform.md`](../marketplaces/indie-game-platform.md)
  (BI21) storefront: self-publish games/assets/music, creator-set pricing, token-set pricing,
  functional NFTs, a no-Solidity SDK. The channel showcases what the store sells.

### 5.1 Cloud-gaming bridge — play-in-browser (Sunshine + Moonlight)

To let viewers/creators **play in a browser** (and to stream gameplay without a second PC):

- **Sunshine** ([github.com/LizardByte/Sunshine](https://github.com/LizardByte/Sunshine),
  GPLv3) — self-hosted **game-stream host** (a free/libre NVIDIA-GameStream-compatible host).
- **Moonlight** ([moonlight-stream.org](https://moonlight-stream.org), GPLv3) — the **client**
  (desktop / mobile / **embeddable web**) that connects to a Sunshine host.

Sunshine (host) + Moonlight (client) gives a **self-hosted, play-in-browser** bridge we own
end-to-end — no third-party cloud-gaming platform, consistent with the self-host posture.

> **Boundary reminder:** game *rendering/streaming* (Sunshine/Moonlight) is **video/GPU-render
> bandwidth**, and is *still* not Hathor's **inference** GPU (§7). A game-stream host renders
> frames; it does not run the LLM.

---

## 6. Monetization through-line + the DMCA-strike fix

### 6.1 The through-line

**Self-host (§1) + decentralized (§2) + native-token (§4.1), with fees feeding back to
stakers (real-yield).** Concretely:

- **No platform cut** — tips/subs/access are PRANA / community-token transactions, settled on
  our chain, not skimmed by a closed platform.
- **Earn from the rail** — running an **SPK proof-of-access node** (§2) turns
  storage/bandwidth from pure cost into a (modest) reward line.
- **Real-yield to stakers** — protocol fees taken at the media/value edges route through the
  same fee → treasury → **ve-staker** plumbing the rest of PRANA uses (the
  `SettlementFeeHook` / `HathorFeeTreasury` family; treasury is **DAO-gated and never trades**,
  per `hathor-runtime.md` §1). Fees are *distributed yield to those who lock stake*, not rent
  to a platform.
- **Access/gating** reuses the existing SIWE/GateRegistry + subscription-NFT stack (no new
  custody, no new trust) for subscriber-only streams/VODs.

### 6.2 The DMCA-strike problem is **solved by our own catalog**

The single most common way a self-hosting streamer gets killed is a **copyright strike for
background music**. We design that failure mode *out*: stream only over our **own
Creative-Commons / Public-Domain music catalog**, governed by the clean-corpus discipline:

- **Cross-link:** [`ai-music-clean-corpus-note.md`](./ai-music-clean-corpus-note.md) (EE2-13)
  — the train-clean / play-clean tiering (PD/CC0/CC-BY in; CC-ND and unknown-license **out**;
  CC-NC out of monetized output) and the per-asset provenance manifest.
- **Cross-link:** the **AI-music stack** (SX1, sibling spec in this backlog item) — our
  *generated* original music, CC0-dedicated by us, as the highest-trust "always-in" tier.

Because every track on-air is either **ours** or **verified PD/CC-cleared-for-the-intended-
commerciality**, there is **no third-party rightsholder to issue a strike**. The provenance
manifest makes each broadcast's audio defensible after the fact. This is the audio analog of
the embed allow-list's "be a *window*, never a *host*" posture (`youtube-embed-whitelist-spec.md`):
on the music we *do* host on-air, we host **only** what we are entitled to.

---

## 7. CAUTION — streaming bandwidth is NOT Hathor's inference GPU (load-bearing)

**This is the most important architectural property of the whole vertical. Do not collapse
these two systems.**

| | **Streaming/media plane** (this doc) | **Inference/compute plane** (`hathor-runtime.md`) |
|---|---|---|
| Moves | **Video bytes** — encode, ingest, transcode, store, deliver | **Tokens/logits** — LLM/ASR/TTS forward passes |
| Hardware | Encoder + network + storage (OBS, Owncast/PeerTube/SRS, SPK/IPFS, Sunshine render) | **GPU inference** — the River (Petals/Hivemind), clustered vLLM, rented/paid GPU |
| Scales with | Viewers, resolution, hours of VOD | Prompt volume, model size, context length |
| Bottleneck | **Bandwidth + storage** | **GPU VRAM + FLOPs** |
| Failure mode | Buffering / dropped stream | Slow/empty Oracle answer (ladder falls through, §3 of runtime) |
| Owner | media/SoapBox ops | PRANA useful-work / rented-GPU compute layer |

- Standing up Owncast/PeerTube/SRS, an SPK node, or a Sunshine game-stream host **does not add
  one unit of LLM inference capacity**. Hathor's brain is served by the **separate** compute
  ladder; the channel merely *carries the result*.
- Conversely, the inference layer's GPUs are **not** sized for, billed for, or trusted with
  video CDN duty. A media bandwidth spike must never be answered by spending the **GPU
  inference** budget, and an inference shortage must never be papered over with **media**
  hardware.
- **Two budgets, two failure modes, two trust models.** A video CDN serving the wrong frame is
  a glitch; the inference layer returning the wrong *answer* is a verification problem governed
  by the attestation/quorum rails (`hathor-runtime.md` §4.3). Keeping them separate keeps each
  one's guarantees intact.

**One sentence to carry forward:** *the stream is the mouth; the GPU layer is the mind — wire
them together, budget them apart.*

---

## 8. Where this fits / project citations

**Ecosystem cross-links**
- Brain + GPU runtime the body rides: [`hathor-runtime.md`](../compute/hathor-runtime.md) (AG10).
- DMCA-safe music catalog: [`ai-music-clean-corpus-note.md`](./ai-music-clean-corpus-note.md)
  (EE2-13); generated-music stack: SX1 (sibling).
- Embed/window posture (3Speak is allow-listed): [`youtube-embed-whitelist-spec.md`](./youtube-embed-whitelist-spec.md) (EE2-11).
- On-channel games / store: [`indie-game-platform.md`](../marketplaces/indie-game-platform.md) (BI21); Luanti sovereign economy world (LL1 lineage).
- Stream chat: the Matrix/Element self-host comms layer (U1) + Owncast built-in chat.
- Fee → treasury → staker plumbing: `SettlementFeeHook` / `HathorFeeTreasury` (PP1/PP3),
  ve-staking — treasury **never trades** (`hathor-runtime.md` §1).

**Upstream projects cited (all public; free/libre or commercial-OK)**
- Encoder: **OBS Studio**.
- Self-host servers: **Owncast**, **PeerTube**, **Restreamer (datarhei)**, **Ant Media**,
  **SRS**, **MediaMTX**.
- Decentralized video/storage: **3Speak**, **SPK Network** (IPFS/CID, proof-of-access,
  Breakaway Communities), on **Hive** (dTube lineage).
- Avatar: **OpenSeeFace**, **VSeeFace**, **Inochi2D**, **VRoid Studio** (VRM).
- AI VTuber keystone: **Open-LLM-VTuber** (MIT) — Qwen / ASR / TTS / Live2D / Letta / MCP /
  live-chat.
- Games: **Luanti** (voxel), **Sunshine** (host) + **Moonlight** (client) cloud-gaming bridge.

> **Public-repo safety:** this doc names only public projects and capabilities. It records
> **no** founder PII, **no** server/host/IP/credential, and **no** backend operator detail —
> all of which live only in gitignored ops notes. Streaming infrastructure here is described
> as *what to run*, never *where it runs*.
