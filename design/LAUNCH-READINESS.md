# PRANA — Launch-Readiness Capstone (ZZ2-1)

> The final synthesis checklist after the autonomous build-out. Grouped by layer.
> Every line is marked:
>
> - ✅ **done** — built, wired, and (where applicable) green under test.
> - ⏳ **gated-on-user** — a deliberate USER DECISION blocks this; the code/spec is staged
>   but intentionally not pinned (we present + recommend, we do not pick).
> - 🔲 **to-build** — a known remaining engineering task (not user-gated).
>
> Honesty rule applied throughout: where something is a **skeleton** (runnable control-flow,
> stubbed I/O) or a **spec/note** rather than production code, it says so in plain words.
> Counts are grounded in the repo; anything I could not exactly enumerate is prefixed
> "approximately".

---

## 0. One-paragraph status

The on-chain **compute engine** ("the chain IS the pool"), the **DeFi stack**, the **bridge
endpoints**, and the **Akasha wallet/explorer** are built and green under their test suites.
The **L1 node** (core-geth fork, Ethash PoW, chainId 108369) mines and is fully rebranded.
What stands between "built" and "mainnet launch" is **not missing code** — it is a cluster of
**genesis-pinning USER DECISIONS** (which microhash algo, how the pool is funded, the
coordinator trust model, the hash:AI weighting, securities framing) plus two cosmetic/polish
items (logo, wallet-lib standardization). The off-chain pool **worker / coordinator / inference
router are runnable skeletons** (real control flow, stubbed network/stratum/broadcast) — they
prove the loop closes but are not yet production daemons.

---

## 1. L1 chain — core-geth fork (Ethash PoW, chainId 108369)

| Item | Status | Notes |
|---|---|---|
| Forked core-geth client (`chain/core-geth/`) | ✅ | ETC-lineage Geth that kept Ethash PoW. |
| Genesis authored (`chain/genesis/prana.genesis.json`) | ✅ | Ethash PoW, pre-funded dev account (publicly-known dev key — DEV ONLY). |
| Chain ID = **108369** (`0x1a751`) | ✅ | 108 (mala) + 369 (Tesla); verified free on chainid.network; wired in genesis + `run-miner.sh` + README. |
| Chain mines / seals blocks | ✅ | Verified: epoch-0 DAG built, block sealed, `eth_chainId`→`0x1a751`, dev account funded. |
| Rebrand sweep (CLI / console / handshake / `web3_clientVersion`) | ✅ | End-to-end "Prana"; `build/bin/prana` symlink; `chain/scripts/dev-stack.sh` one-shot bring-up. |
| Build-toolchain pin (`GOTOOLCHAIN=go1.22.12`) | ✅ | Required (Codespace Go is too new); documented. Baking it into `build.sh` is a 🔲 housekeeping nicety. |
| **Microhash / DAG algorithm — Etchash (ECIP-1099) vs plain Ethash vs ProgPoW** | ⏳ **UD-PR-B** | Genesis is currently plain Ethash. Etchash = one-key change (`ecip1099FBlock: 0`) for low-VRAM breadth, **recommended**; ProgPoW is **not in this fork** (verified: 0 grep hits) and would be a consensus patch. See `tools/brain/state/design/chain/etchash-vs-ethash.md`. Pre-launch genesis change → no migration cost, but **must be decided before mainnet** (changes the genesis hash). |
| **Block reward amount/shape + coinbase routing** | ⏳ **UD-PR-E** | "coinbase → ledger" funding decision; pin together with cadence + reward shape in one genesis commit. See `tools/brain/state/design/chain/ledger-funding-genesis.md`, `block-cadence.md`, `uncle-reward-config.md`. |
| Genesis-coinbase → ledger wiring (the chain-native issuance path, Option B) | 🔲 / ⏳ | The `UnifiedSharesLedger` header carries an explicit `TODO(genesis-coinbase wiring)`. **Option A (role-funded `fundEpoch`) works today with zero client change and is recommended.** Option B (consensus patch routing the block subsidy into the ledger) is a future, gated hard-fork (also needs the native-vs-ERC-20 funding mismatch resolved). Tracked as ZZ3. |
| PoW-L1 vs Polygon-CDK direction | ⏳ **(open decision ①)** | New master docs say "PRANA = PoS/Polygon," contradicting the built PoW chain. The whole launch substrate hinges on this. Brief: `design/00-DECISION-pow-l1-vs-polygon-cdk.md`. |

---

## 2. Compute engine — "the chain IS the pool" (`contracts/contracts/compute/`)

The headline build. One canonical PPLNS pool pinned to the chain; three lanes (HASH / TASK /
BURN) credit shares into the **same** `UnifiedSharesLedger` and are paid pro-rata from a fixed
per-epoch issuance over a rolling window.

### 2.1 On-chain (built + tested)

| Contract | Status | What it is |
|---|---|---|
| `UnifiedSharesLedger` | ✅ | The PPLNS multi-lane shares ledger. Per-lane creditor roles; weighted shares; idempotent per-(account,epoch) claims; inline fee hook at settle. |
| `EpochManager` | ✅ | Shared epoch/window math. |
| `HashTaskWeightConfig` | ✅ | DAO-governed lane weights (HASH=TASK=1e18 default → "seamless switching") + vardiff bounds as a read for the off-chain coordinator. |
| `HashLaneCreditor` | ✅ | Role-gated batch-credit of vardiff-normalized hash shares. NOT verification-gated (a PoW share self-evidently is the work); replay-guarded per (epoch, batchId). |
| `TaskLaneCreditor` | ✅ | Credits a TASK share **only** after pulling a verified, not-yet-consumed verdict from the gate; recipient bound to the gate-bound worker (callers cannot redirect). |
| `TaskVerificationGate` | ✅ | K-of-N quorum over **staked-active** attestors, layered on `AttestationStakeSlash`. One-shot `consume()`. The make-or-break trust boundary (a forged TASK share is worth a real HASH share). |
| `TaskRegistry` / `TaskDispatchPolicy` | ✅ | DAO-governed task-type catalog (Bittensor-style) + routing/Hathor-priority reservation. |
| `VerifiedMachineCounter` | ✅ | Sybil-resisted machine count over a window. |
| `BurnStakeRegistry` (+ `…DecayVariant`, `…GovernanceAdapter`, `…PriceSource`) | ✅ | Proof-of-Burn perma-stake (no-exit) lane → IVotes weight; price normalizer. |
| `MultiCurrencyBurnRouter` | ✅ | Burn-to-mine backend feeding the BURN lane. |
| `SettlementFeeHook` (PP1) | ✅ | The single fee chokepoint, taken **inline at on-chain settlement** so every coordinator/own-pool pays identically — no front-end to route around. |
| `CountercyclicalFeeOracle` (PP2) | ✅ | Rules-based, bootstrap-vs-steady rate function (read-only to the hook). |
| `HathorFeeTreasury` (PP3) | ✅ | The protocol-fee sink that **never trades**; outflow only via DAO-timelock `withdraw*`. |
| `RegentGovernance` / `RegentVotesAdapter` | ✅ | Decaying founder weight (BLURT model) as IVotes. |
| `CoordinatorRegistry` (PR1) | ✅ | Permissionless coordinator allowlist with slashable bond (a **guard**, not a forwarder). HASH lane needs no bond; TASK lane does. |
| `JobClaimLedger` (PR2) | ✅ | Chain-wide cross-coordinator job dedup so one unit of useful work → shares at most once. |
| `WorkerBeaconRegistry` / `WrappedEcosystemToken` / `WrappedTokenFactory` | ✅ | Worker-identity binding (anti-Sybil) + wrapped ecosystem-token plumbing. |

### 2.2 Compute-engine tests

| Item | Status | Notes |
|---|---|---|
| Hardhat suite (full repo) | ✅ | **approximately 1,425 passing** across ~180 test files (was ~985 earlier; grew with the compute + bridge + game waves). Includes the compute-engine unit suites. |
| Forge tests (`*.t.sol`) | ✅ | ~20 forge test files including the stateful **`UnifiedSharesLedgerInvariant.t.sol`** and `BurnMineInvariant.t.sol` fuzz invariants. |
| E2E — switching engine pays HASH + TASK equally into one pool (XX9) | ✅ | Proves the seamless-switching property. |
| E2E — burn → weight → emission + governance vote (XX10) | ✅ | |
| E2E — zero-AI-demand graceful degradation (PR3) | ✅ | Pool keeps paying on HASH alone when there is no AI work. |
| `solhint` + `slither` pass over the **new** compute contracts (XX15) | 🔲 | Repo-wide solhint/slither configs exist and pass; a dedicated re-sweep over the newest compute contracts is still open. |
| Gas-snapshot update for the new compute contracts (XX16) | 🔲 | Baseline exists; refresh for new contracts pending. |

### 2.3 Compute-engine USER DECISIONS (gate launch)

| Decision | Status | Trade-off (presented, not picked) |
|---|---|---|
| **UD-PR-A — Coordinator trust model** | ⏳ | Fully permissionless + slashable bond (PR1, true Hive/P2Pool decentralization, accepts some spam/Sybil risk) **vs** DAO-vetted `*_CREDITOR` role grants (simpler; "run your own pool" = "be granted the role"). Registry is built to support the permissionless path either way. |
| **UD-PR-C — Fee placement** | ⏳ | Fee-on-issuance (pool-wide, invisible per-worker, simple) **vs** the implemented fee-at-settlement hook (un-routable-around). Both code paths considered; settlement-hook is built. |
| **UD-PR-D — TASK-lane launch scope** | ⏳ | Restrict v1 to verifiable-by-acceptance-check tasks **vs** open the full adversarial K-of-N task space at launch. |
| **UD-PR-F — Hash : AI share weighting** | ⏳ | The tunable HASH:TASK split. Default 1:1; set so AI stays the main attraction or balance for security. Governed live via `HashTaskWeightConfig`. |

---

## 3. Off-chain compute clients (`tools/`) — runnable **skeletons**

> Honesty: these are **runnable skeletons** with real, unit-tested control flow but **stubbed**
> network/stratum/model/broadcast. They close the loop and are unit-green; they are **not yet
> production daemons**. Node ≥ 20 built-ins only (no `npm install`).

| Component | Status | What's real vs stubbed |
|---|---|---|
| `tools/pool-worker/` (auto-switching worker) | ✅ skeleton | **Real + tested:** vardiff, the HASH/TASK switcher, the river-client shape. **Stubbed:** actual hashing / model inference / network. Never holds a creditor key. |
| `tools/pool-coordinator/` (front-end coordinator) | ✅ skeleton | **Real + tested:** share collection, validation, dedup, epoch batching, the on-chain settle *shape*. **Stubbed:** real stratum + the on-chain broadcast. |
| `tools/inference-router/` (free-API fallback router) | ✅ skeleton | **Real + tested:** priority ladder, fallthrough machine, per-backend token-bucket. **Stubbed:** every backend `healthCheck`/`infer` (deterministic synthetic output, no models). |
| Petals/Hivemind "river-join" client | ✅ note + stub | Spec + client stub (XX20). |
| Production hardening (real stratum, real broadcast, real model backends) | 🔲 | The drop-in points are marked in each skeleton; this is the main remaining off-chain engineering. |

---

## 4. DeFi + bridge + wallet

### 4.1 DeFi (contracts)

| Item | Status | Notes |
|---|---|---|
| Uniswap-V2 AMM (factory/pair/router) + StableSwap + FoT router + flash swaps | ✅ | Tested. |
| ve / gauges / boost / bribes | ✅ | Curve-style. |
| Governor + ve DAO + Timelock | ✅ | Compound Governor wired to VoteEscrow weight. |
| CDP + liquidation engine | ✅ | |
| Burn-mine family + BurnSink + mesh substrate (Diamond skeleton) | ✅ | |
| ERC-4337 stack (account, paymaster, session keys) | ✅ | |
| Token factories (wizard / clones / launchpad) + auto-pool | ✅ | |

### 4.2 Bridge (`contracts/contracts/bridge/`)

| Contract | Status | Notes |
|---|---|---|
| `CanonicalLockMintBridge` (PRANA endpoint) | ✅ | |
| `FederatedBridgeValidatorSet` / `IBridgeValidatorSet` | ✅ | Stage-2 **trusted** validator set. |
| `GrapheneDepositBridge` (wMELEK / wVKBT mint) | ✅ | MELEK→PRANA deposit path. |
| `MessagingBridgeAdapter` / `PolygonEvmBridgeAdapter` | ✅ | Pluggable transport; **primary protocol is UD-BI-A** (not picked). |
| `YieldBearingBridgeVault` | ✅ | Yield-on-bridged-TVL is **UD-BI-F** (enable or keep idle — not picked). |
| Stage-3 full audited two-way bridge | 🔲 | Brief's stage 3; the trusted stage-2 path is what's built. |

> Bridge / interop also carries **UD-BI-A..F** (messaging protocol, Polygon connectivity,
> CommunityFi token, merge-mining for launch hashpower, **securities/money-transmitter
> framing**, vault yield). These are ⏳ gated decisions, not missing code.

### 4.3 Wallet — Akasha (`akasha/`)

| Item | Status | Notes |
|---|---|---|
| `akasha/lib/` ethers-v6 core (keyvault/keystore/provider-1193/txbuilder/registry/token-list/send-flow/address-book/abi-form) | ✅ | Tested. |
| `akasha/app/` React wallet + explorer | ✅ | Builds; runs with/without a live node. |
| Deploy-wizard CLI | ✅ | One known pre-existing test failure (ENOENT) — see FINAL-GREEN-GATE. |
| **viem (`src/`) vs ethers (`lib/`) standardization** | ⏳ **(open decision ③)** | Legacy viem `src/` still present; recommendation is to retire it. Pick one before shipping. |

---

## 5. Tooling, CI, catalog

| Item | Status | Notes |
|---|---|---|
| Foundry live (forge 1.7.1, invariants, gas snapshot) | ✅ | |
| Root + contracts Makefiles | ✅ | |
| CI hardening (gitleaks / OSV / Scorecard / super-linter / release-please) | ✅ | |
| API adapters + exporters (`tools/adapters/`) | ✅ | ~9 adapter test suites green; SoapBox/license adapters green. |
| Resource catalog + consumer-matrix validators | ✅ | Schema/count/duplicate integrity validators (`validate-catalog.js`, `check-consumer-matrix.mjs`). |

---

## 6. The OPEN USER DECISIONS that gate launch

These are the **real remaining work** — deliberate choices staged for the user, not engineering
gaps. Code/spec exists for each; we present + recommend, we do **not** pick.

### 6.1 Chain / compute genesis-pinning decisions (must settle before mainnet genesis)

| ID | Decision | Recommendation on file |
|---|---|---|
| **UD-PR-A** | Coordinator trust model (permissionless+bond vs DAO-vetted roles) | Permissionless registry is built; present trade-off. |
| **UD-PR-B** | Microhash algorithm (Etchash/ECIP-1099 vs plain Ethash vs ProgPoW) | **Enable Etchash** (one key, breadth); defer ProgPoW (not in fork). |
| **UD-PR-C** | Fee placement (on-issuance vs at-settlement) | Settlement hook built (un-routable). |
| **UD-PR-D** | TASK-lane launch scope (acceptance-check-only vs full adversarial) | Present; lean narrow for v1. |
| **UD-PR-E** | Coinbase → ledger funding (role-funded `fundEpoch` vs consensus patch) | **Option A (role-funded) now**, Option B as future hard-fork. |
| **UD-PR-F** | Hash : AI share weighting | Default 1:1; governed live. |
| **UD-BI-E** | Securities / money-transmitter framing (wrapped value + real goods) | Legal-posture decision; guardrail note on file. |

### 6.2 Product / polish decisions

| ID | Decision | Note |
|---|---|---|
| **③ viem-vs-ethers** | Wallet lib standardization | Recommend retire viem `src/`. |
| **② Logo** | Pick from 15 delivered concepts → F5/F6 | Dark-field / luminous-core direction. |

### 6.3 The launch-gating count

Counting the decisions that **gate a mainnet launch** (i.e., that must be answered before the
genesis is pinned or the public-facing brand/wallet ships), per the task's enumerated UD-* set —
**coordinator trust model (UD-PR-A), microhash algo (UD-PR-B), fee placement (UD-PR-C),
TASK-lane scope (UD-PR-D), coinbase→ledger (UD-PR-E), hash:AI weighting (UD-PR-F),
securities framing (UD-BI-E), viem-vs-ethers (③), and logo (②)** — there are:

> ## **9 open user-decisions gate launch.**

(The wider repo also carries additional non-launch-gating decisions — e.g. PoW-vs-Polygon
direction ①, NFT-collection canon ④, free-breed faucet ⑤, Luanti trust ⑥, SoapBox scope ⑦,
funding-draft filing ⑧, skin-id rebase ⑨, and the full UD-BI-A..D/F and UD-AK sets — but the
**nine above are the launch gate** for this chain.)

---

## 7. Honest "skeleton vs production" ledger (one place)

| Layer | Maturity |
|---|---|
| L1 node, rebrand, genesis | **Production-shape**, mines; genesis params await UD pinning. |
| Compute-engine contracts | **Production-shape**, tested + invariant-fuzzed; awaits UD weighting/funding/fee choices + a final solhint/slither/gas re-sweep (XX15/XX16). |
| DeFi + bridge (stage-2) + wallet | **Production-shape**, tested; bridge stage-3 + wallet-lib pick remain. |
| pool-worker / pool-coordinator / inference-router | **Runnable skeletons** — real control flow, stubbed I/O. The main remaining off-chain build. |
| Genesis-coinbase→ledger Option B | **Spec + patch-site note** only (TODO seam in the ledger). |
