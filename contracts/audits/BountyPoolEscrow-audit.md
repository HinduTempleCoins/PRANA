# Audit: ContributionBountyEscrow → BountyPoolEscrow (2026-10-19)

## Scope
- **ContributionBountyEscrow.sol** (existing, not deployed on PRANA mainnet 712217): one sponsor escrows one ERC-20 amount; an attestor releases it all to one worker; the sponsor can cancel any time.
- **BountyPoolEscrow.sol** (new, replaces it for Pentecaust Bounty Pools): a sponsor funds a pool of `slots × perTaskReward` in any ERC-20, open until a deadline; the attestor pays one reward per verified task (each task reference once); after the deadline the sponsor reclaims only what is left.
- External systems: ERC-20 tokens chosen by the sponsor (KULA, WPRANA, wVKBT, wCURE, wMELEK on PRANA mainnet); the off-chain verifier that holds ATTESTOR_ROLE.
- Roles: DEFAULT_ADMIN_ROLE (grants/revokes attestors), ATTESTOR_ROLE (release). No upgradeability, no pause, no owner withdrawal.
- External functions: `createPool`, `release`, `reclaim`, `count`, AccessControl's role functions.

## Categories walked
Attacker's mindset (reentrancy, front-running, DOS, donation), Basics (access control, arithmetic, initialisation), Token (fee-on-transfer, rebasing, non-standard returns), Centralization, Heuristics. Static analysis: Slither (102 detectors). Not applicable: Signature, Hash/Merkle, Multi-chain, Low-level (none used), DeFi pricing/oracles.

## Findings on ContributionBountyEscrow (why it was replaced)
1. **Medium — sponsor can cancel finished work.** `cancel` is allowed until `attestAndRelease`, so a sponsor watching the mempool (or just impatient) can pull the pot after a worker has done the task and before the attestor pays. *Front-running / attacker's mindset.* Fixed in BountyPoolEscrow: no cancel before the deadline; `reclaim` only after it.
2. **Medium — model mismatch.** The Pentecaust pool model (`pot`, `perTaskReward`, `slots`) needs many payouts from one pot; the contract supports exactly one payout per bounty, so a pool would need one transaction and one escrow per task. Fixed: pools with slots.
3. **Low — fee-on-transfer accounting.** `post` records `amount`, not what arrived; a fee token leaves the contract short and the last payout reverts. *Token / fee-on-transfer.* Fixed: balance-difference check, fee tokens refused.
4. **Informational — single token per deployment** (`token` immutable). Fixed: token per pool.
5. **Informational — no task reference**, so double-paying the same submission is not prevented on-chain. Fixed: `taskPaid[pool][taskRef]`.

## Findings on BountyPoolEscrow
- **No Critical/High/Medium findings.**
- **Centralization (Informational, acknowledged):** the attestor decides who did a task and can release to any address, including itself. That is the verifier's job by design; mitigations: keep ATTESTOR_ROLE on a MELEK-Signer-custodied account with a scoped token, never a raw local key; publish every `Released` event; move DEFAULT_ADMIN_ROLE to a multisig before third-party sponsors use it.
- **Sponsor-chosen tokens (Informational):** any ERC-20 can back a pool; a malicious token could misbehave on transfer. The pool's display should show the token address and the UI should mark the known ecosystem tokens.

## Static analysis (Slither) — all reviewed
| Detector | Location | Verdict |
|---|---|---|
| incorrect-equality | createPool balance check | Intentional: rejects fee-on-transfer tokens; measured within one transaction, so a donation cannot break it |
| reentrancy-benign | createPool push after transferFrom | `nonReentrant`; no state read depends on the order |
| timestamp ×4 | deadline checks | Day-scale deadlines; validator timestamp drift (seconds) is irrelevant |

## Tests (Foundry, test-forge/BountyPoolEscrow.t.sol) — 8/8 pass
Full pot pulled; one payout per task; slots exhausted stop payouts; only the attestor releases; no reclaim while open; reclaim returns only the remainder and only to the sponsor; pools in different tokens are separate; fee-on-transfer and bad parameters rejected; fuzz (256 runs): total paid ≤ pot and balances always reconcile.

## Open questions
- Who holds ATTESTOR_ROLE and DEFAULT_ADMIN_ROLE at deployment (recommend: Hathor's MELEK-Signer-custodied PRANA wallet, then a multisig for admin).
