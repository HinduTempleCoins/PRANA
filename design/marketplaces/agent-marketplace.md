# Agent marketplace spec (BI22)

> Scope: a **deploy/hire AI-agent marketplace** — list agents, hire them to act across
> MELEK / Discord / SoapBox, settle payment on PRANA, all under a **scoped-permission**
> trust model. Spec only. Builds on the on-chain agent-account + session-key primitives
> that already exist; adds no new custody.

---

## 1. The model

A two-sided market:
- **Builders** publish an agent (a named capability: a bot, a workflow, an inference
  service) with a price and a permission scope it requests.
- **Hirers** browse, hire an agent, and grant it a **scoped, revocable** permission to act
  on their behalf. Payment settles in token on PRANA.

Flagship first-party agents: **Hathor** (the read-only oracle/witness, governs nothing it
is not granted) and **Cheetah** (a moderation/utility agent). Third-party agents list
alongside them.

---

## 2. The trust model — the 3Commas scoped-key pattern (load-bearing)

The non-negotiable safety rule (Build-Interop §11/§12): an agent gets the **least authority
that does its job, and the grant is always revocable**. Modeled on the **3Commas** scoped
API-key pattern:

| Scope | What it can do | Example agent |
|-------|----------------|---------------|
| **View-only** | read chain state / accounts; never sign | Hathor (Clarity Score, watchlist) |
| **Trade-never-withdraw** | execute scoped actions (e.g. swap within caps), but **cannot withdraw** to an outside address | a DeFi/keeper agent |
| **Revocable** | every grant can be cut off instantly by the principal | all of them |

This is enforced **on-chain**, not by trust in the marketplace, via the existing primitives:

| Primitive | Role |
|-----------|------|
| `SessionKeyValidator` (L23) | session keys scoped to selectors/targets/caps/expiry (ERC-4337-compatible) |
| ERC-4337 smart account (L25) | the agent acts through a smart account whose `validateUserOp` enforces the session-key policy |
| `KeeperGatedVault` (GG1) | rules/caps vault + paper-trade mode — an agent can be hired in **paper-trade** first |
| the on-chain agent-account spec (V2) + agent↔chain bridge (V3) | the signer-abstraction + policy boundary an agent runs behind |

A hire = **granting a session key with a scope**, recorded on-chain; revoke = killing that
key. The marketplace front-end just composes these grants; it never holds the agent's or the
hirer's keys.

---

## 3. Cross-surface reach (MELEK / Discord / SoapBox)

An agent can act across surfaces, each with its **own** scoped auth — the chain grant
authorizes the *value/contract* actions; the social-surface grant authorizes posting/moderation:
- **MELEK** — Hive-family auth stack (Keychain / HiveSigner OAuth-scoped / HiveAuth QR);
  Hathor authenticates **read/posting-only**, never withdraw.
- **Discord / SoapBox** — bot tokens / OAuth scopes on those platforms.
- **PRANA value actions** — the on-chain session-key scope above.

The principle is identical everywhere: **scoped, revocable, never withdraw-by-default**.

---

## 4. Listing + settlement flow

```
 1. Builder lists an agent: capability, price (token), requested permission scope, surfaces.
 2. Hirer reviews the requested scope (shown in plain language) and hires.
 3. The hire grants a scoped session key (SessionKeyValidator) + any social-surface scopes.
    Optionally starts in KeeperGatedVault paper-trade mode (no real value moved).
 4. The agent acts within scope; every action is on-chain-policy-checked or social-scope-checked.
 5. Payment settles in token (subscription via SubscriptionLockNFT, or per-job via escrow).
 6. Hirer can revoke at any time (kill the session key) — the agent is cut off instantly.
```

---

## 5. Guardrails

- **No custody, no withdraw-by-default.** The marketplace never holds keys; agents act
  through scoped keys that, by default, cannot withdraw to external addresses.
- **Paper-trade first.** Value-acting agents can be evaluated in `KeeperGatedVault`
  paper-trade mode before any real funds are at risk.
- **Reputation.** `MarketplaceReputation` (BI19) scores builders/agents from settled vs
  disputed outcomes, so the market self-selects trustworthy agents.
- **Hathor stays read-only** except where explicitly granted posting scope — she governs
  nothing she is not granted, consistent with the oracle framing
  (`design/research/oracle-vs-oracalization.md`).

---

## Cross-references
- `contracts/SessionKeyValidator.sol` (L23), the ERC-4337 smart account (L25) — the scoped-key enforcement.
- `contracts/KeeperGatedVault.sol` (GG1) — caps + paper-trade mode.
- `contracts/MarketplaceReputation.sol` (BI19) — builder/agent reputation.
- `design/research/oracle-vs-oracalization.md` — Hathor's read-only/oracle boundary.
- `design/marketplaces/indie-game-platform.md`, `analytics-spec.md` — sibling marketplaces.
