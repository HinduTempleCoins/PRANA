# PRANA — Engine Diagrams (ZZ2-2)

> The "chain IS the pool" compute engine and the bridge/wallet/ecosystem layer, drawn with
> the **real contract names** from `contracts/contracts/compute/` and `…/bridge/`. Mermaid
> first; an ASCII recap of the closed loop follows for clarity.

---

## Diagram 1 — The chain-as-pool compute engine

How a **HASH** share, a **TASK** share, and a **BURN** all flow into one
`UnifiedSharesLedger`, how PPLNS pays out, where the fee + treasury sit, and how the
off-chain worker→coordinator→on-chain loop closes through the permissionless coordinator gate.

```mermaid
flowchart TB
    %% ============ OFF-CHAIN ============
    subgraph OFFCHAIN["off-chain (runnable skeletons, tools/)"]
        WORKER["pool-worker<br/>(auto-switch HASH/TASK,<br/>vardiff; never holds a creditor key)"]
        COORD["pool-coordinator<br/>(collect, validate, dedup,<br/>epoch-batch, settle-shape)"]
        ROUTER["inference-router<br/>(river → free-API → paid cloud<br/>fallthrough ladder)"]
        ATTEST["off-chain attestors<br/>(re-run / check TASK output)"]
        WORKER -->|"shares over HTTP"| COORD
        WORKER -. "TASK inference" .-> ROUTER
    end

    %% ============ COORDINATOR GATING ============
    subgraph GATE_OPS["permissionless coordinator gate (on-chain)"]
        CREG["CoordinatorRegistry (PR1)<br/>slashable bond · allowlist guard<br/>requireActiveCoordinator()"]
        JOBS["JobClaimLedger (PR2)<br/>cross-coordinator job dedup<br/>claim→settle, 1 job = 1 credit"]
        COORD -->|"must be bonded+active"| CREG
        COORD -->|"claim(jobId,worker)"| JOBS
    end

    %% ============ LANE CREDITORS ============
    subgraph LANES["the three lanes → one ledger"]
        HCRED["HashLaneCreditor (NN2)<br/>CREDITOR_ROLE · replay-guarded<br/>(self-verifying: a PoW share IS work)"]
        TGATE["TaskVerificationGate (NN4)<br/>K-of-N over staked-active attestors<br/>(AttestationStakeSlash.isActive)<br/>one-shot consume()"]
        TCRED["TaskLaneCreditor (NN3)<br/>credits ONLY a verified+unconsumed<br/>verdict; recipient = gate-bound worker"]
        BURN["MultiCurrencyBurnRouter (OO3)<br/>+ BurnStakeRegistry (OO1)<br/>proof-of-burn perma-stake (no exit)"]
    end

    COORD -->|"submitBatch(worker,hashShares)[]"| HCRED
    ATTEST -->|"attest(claimId)"| TGATE
    TGATE -->|"isVerified && consume → worker"| TCRED

    %% ============ WEIGHTS ============
    WCFG["HashTaskWeightConfig (NN5)<br/>lane weights (HASH=TASK=1e18 default)<br/>+ vardiff bounds · DAO-governed"]
    WCFG -. "laneWeight(lane)" .-> LEDGER

    %% ============ THE LEDGER ============
    subgraph POOL["the one canonical pool (baked into the chain)"]
        EPOCH["EpochManager (XX4)<br/>epoch / PPLNS window math"]
        LEDGER["UnifiedSharesLedger (NN1)<br/>poolShares += amount*laneWeight/1e18<br/>PPLNS over rolling window<br/>payout = issuance * acctWin / totWin<br/>idempotent per (account,epoch)"]
        EPOCH --> LEDGER
    end

    HCRED -->|"credit Lane.HASH"| LEDGER
    TCRED -->|"credit Lane.TASK"| LEDGER
    BURN  -->|"credit Lane.BURN"| LEDGER

    %% ============ FUNDING ============
    FUND["funding (totalFunded budget)<br/>A: FUNDER_ROLE.fundEpoch()  ✅ today<br/>B: genesis-coinbase hook  ⏳ TODO seam"]
    FUND -->|"PRANA issuance budget"| LEDGER

    %% ============ SETTLEMENT + FEE ============
    subgraph SETTLE["settlement + the Hathor skim"]
        FEEHOOK["SettlementFeeHook (PP1)<br/>inline at settle · un-routable-around<br/>fee = amount * rate/1e4"]
        FEEORA["CountercyclicalFeeOracle (PP2)<br/>rules-based rate (read-only)"]
        TREAS["HathorFeeTreasury (PP3)<br/>NEVER trades · DAO-timelock withdraw only"]
        FEEORA -. "currentRateBps" .-> FEEHOOK
        FEEHOOK -->|"fee"| TREAS
    end

    %% ============ PAYOUT ============
    MINER(["worker / contributor<br/>(beacon-bound payout addr)"])
    LEDGER -->|"claim(epoch)"| FEEHOOK
    FEEHOOK -->|"net = amount - fee"| MINER

    %% ============ GOVERNANCE ============
    subgraph GOV["governance over the engine"]
        REGENT["RegentGovernance (QQ1)<br/>+ RegentVotesAdapter (QQ2)<br/>decaying founder weight"]
        BSGOV["BurnStakeGovernanceAdapter (OO2)<br/>burn-weight → IVotes"]
        DAO["DAO Governor + Timelock<br/>(holds WEIGHT_ADMIN / RATE_ADMIN / GOVERNOR)"]
        REGENT --> DAO
        BSGOV --> DAO
        DAO -. "set lane weights" .-> WCFG
        DAO -. "repoint rate oracle" .-> FEEHOOK
        DAO -. "withdraw" .-> TREAS
    end
```

**Read it as:** the worker is *indifferent* to lane (equal weight = seamless switching). HASH
flows straight in (self-verifying, replay-guarded). TASK must pass the K-of-N verification gate
before its creditor will mint a share, and the recipient is pinned by the gate — a coordinator
cannot redirect credit. BURN is a permanent stake lane. All three become `poolShares` in the
**single** `UnifiedSharesLedger`, paid PPLNS from a funded issuance budget. Every payout passes
through `SettlementFeeHook` on-chain, so the Hathor skim is identical for every coordinator and
cannot be dodged by any front-end; the skim lands in a treasury that never trades and only the
DAO timelock can drain.

---

## Diagram 2 — Bridge / wallet / ecosystem layer

How value and identity move between MELEK (Graphene social chain), PRANA (this EVM chain), and
Polygon, and where the Akasha wallet/explorer sits as the single user gateway.

```mermaid
flowchart LR
    subgraph MELEK["MELEK (Graphene social L1)"]
        MTOK["native MELEK / VKBT tokens"]
    end

    subgraph PRANA["PRANA (this EVM chain, chainId 108369)"]
        direction TB
        GDEP["GrapheneDepositBridge<br/>(mint wMELEK / wVKBT)"]
        WTOK["WrappedEcosystemToken (XX1)<br/>+ WrappedTokenFactory (XX2)"]
        CLMB["CanonicalLockMintBridge<br/>(PRANA endpoint)"]
        VSET["FederatedBridgeValidatorSet<br/>(stage-2 TRUSTED set)"]
        MADP["MessagingBridgeAdapter<br/>(transport = UD-BI-A, not picked)"]
        PADP["PolygonEvmBridgeAdapter"]
        YVLT["YieldBearingBridgeVault<br/>(yield = UD-BI-F, not picked)"]
        DEFI["DeFi: V2 AMM / StableSwap /<br/>ve-gauges / Governor / CDP /<br/>burn-mines"]
        COMPUTE["compute engine<br/>(see Diagram 1)"]
    end

    subgraph POLY["Polygon / other EVM"]
        PEVM["EVM endpoint"]
    end

    subgraph AKASHA["Akasha — the user gateway"]
        WALLET["wallet (keyvault / keystore /<br/>EIP-1193 / txbuilder)"]
        EXPL["explorer view (reads RPC)"]
        WIZ["deploy-wizard CLI"]
    end

    MTOK -->|"deposit"| GDEP --> WTOK
    WTOK --> DEFI
    CLMB <-->|"lock-mint / burn-unlock"| VSET
    VSET -. "attest" .- MADP
    MADP <--> PADP <--> PEVM
    CLMB --> YVLT
    DEFI <--> COMPUTE

    WALLET -->|"RPC + sign"| PRANA
    EXPL -->|"read blocks/txs/accounts"| PRANA
    WIZ -->|"deploy + verify"| DEFI
    WALLET -. "initiate bridge" .-> CLMB
```

**Read it as:** MELEK tokens reach PRANA's DeFi as wrapped/pegged assets via
`GrapheneDepositBridge`; cross-EVM movement goes through `CanonicalLockMintBridge` gated by a
**trusted (stage-2)** validator set over a pluggable messaging transport. Akasha is the one
branded front-end (wallet + explorer + deploy-wizard) users touch; it talks to PRANA over RPC
and can initiate a bridge. **Stage-3** (fully audited, two-way) is still to build; the messaging
protocol, Polygon connectivity, and vault-yield toggles are open **UD-BI** decisions.

---

## ASCII recap — the closed loop (one glance)

```
  worker ──shares──▶ coordinator ──(bonded? CoordinatorRegistry)──┐
    │                    │                                        │
    │                    ├──HASH──────────────▶ HashLaneCreditor ─┤
    │                    │                                        ▼
    └──TASK──▶ inference  └──TASK claim──▶ TaskVerificationGate ──▶ TaskLaneCreditor
                router          (K-of-N staked attestors)                │
                                                                         ▼
   BURN ▶ MultiCurrencyBurnRouter ───────────────────────────▶  UnifiedSharesLedger
                                                  (poolShares × laneWeight, PPLNS)
   funding (fundEpoch ✅ / coinbase-hook ⏳) ───────────────────────────▲
                                                                         │
                              claim(epoch) ──▶ SettlementFeeHook ──┬─fee─▶ HathorFeeTreasury
                                                                   └─net──▶ worker payout addr
```

The loop is closed: off-chain work becomes on-chain shares only through a gated, verified,
deduped path; the chain itself pays the worker; the protocol fee is taken at the one on-chain
chokepoint that no front-end can bypass.
