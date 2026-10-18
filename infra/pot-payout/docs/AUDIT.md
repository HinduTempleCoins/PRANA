# PotDistributor + payout pipeline — security audit

Scope: `contracts/src/PotDistributor.sol` (commit as of 2026-10-17, solc 0.8.24, evm london, optimizer 200, OZ v5.0.2),
plus the off-chain trust boundary it relies on (`payout/roundlib.py`, `payout/signer.py`, `payout/relay.py`,
`payout/potd2.py`, pool patch `oep/`, fleet queue `lanes/fleetq.py`).
Method: the `prana-contract-audit` checklist (attacker's mindset, basics, heuristics + by trigger: External-call,
Signature, Hash/Merkle, Centralization, Low-level), Slither 0.11.6, Foundry unit/fuzz/invariant tests, devnet E2E.
Auditor: the same agent that wrote the code. **This is a self-audit, not an independent audit.** Treat it as a
pre-review checklist; an external review before mainnet is recommended.

## 1. Scope summary (step 1 of the skill)
- **What it does:** it receives consensus credits of 98% of the PRANA block reward from fork block F (plain
  `AddBalance`, no code runs). It releases funds only to accounts proven in a Merkle root of cumulative earnings.
  A root needs K-of-M EIP-712 signer signatures and a challenge window that the guardian can veto.
- **External systems:** none on-chain. It reads no oracle and calls no other contract. The only external
  call is the native transfer to the claimant.
- **Token standards:** none. It handles native PRANA only.
- **Privileged roles:**
  - `timelock` (immutable) can set the signer set, threshold, guardian and challenge period.
  - `guardian` can veto a pending root and pause or unpause claims.
  - There is no owner, no upgrade proxy and no withdraw function.
- **External/public functions:**
  - Rounds and claims: `postRoot`, `finalize`, `veto`, `claim`, `claimMany`, `pause`, `unpause`.
  - Governance: `setSigners`, `setGuardian`, `setChallengePeriod`.
  - Views: `receivedTotal`, `signers`, `rootDigest`, `leaf`, `claimable`, `pendingClaimableAt`, and the public getters.
- **Work-gate questions from the skill:**
  - *Can a worker be paid without the recompute matching?* Not on-chain. A root is accepted only with K
    signatures over the exact (round, root, total, inputsHash, endBlock, signerEpoch). Each honest signer signs
    only after an independent recomputation.
  - *Is the quorum enforced on-chain?* Yes: `postRoot` L191-231.
  - *Can rounds be replayed?* No:
    - The round number must be `currentRound+1`.
    - The signed struct includes the round and the `signerEpoch`.
    - The domain separator includes chainId and the contract address.

## 2. Checklist coverage
Categories walked: Attacker's mindset, Basics, Heuristics, External-call, Signature, Hash/Merkle, Centralization,
Low-level. Not applicable: DeFi (no pricing, no AMM), Token (no ERC20/721), Integrations (no Uniswap or Chainlink), Multi-chain/bridge (single chain;
signatures are domain-bound anyway). 41 items reviewed, 9 N/A.

| Category / item | Verdict | Where / evidence |
|---|---|---|
| Reentrancy (single-function) | OK | `nonReentrant` on every state-changing entry (L198, L234, L256, L267). Effects come before the call (`_account` L333-346 then `_send`). Test `test_reentrancy_blocked`. |
| Reentrancy (cross-function) | OK | Same guard on all of them. `veto`/`pause` do not move value. Slither `reentrancy-eth` on the claimMany rollback was reviewed; the rollback restores only pre-call values under the guard. |
| Read-only reentrancy | OK | `receivedTotal()` = balance + totalClaimed. During the external call both are already updated, so the sum is consistent. No other contract consumes it. |
| DoS by reverting / gas-griefing recipient | OK | `claimMany` caps at `PUSH_GAS`=60k and skips failures with an exact rollback. Return data is not copied (assembly `call`, L350-354). Test `test_claimMany_skips_griefers_and_rolls_back`. |
| DoS on posting (unbounded loop) | OK | Signature loop is bounded by MAX_SIGNERS=32 (sigs must be distinct signers). |
| Front-running `postRoot` | OK / acceptable | Anyone with the same K signatures posts the same content. There is nothing to steal. |
| Front-running `claim` | OK | Funds always go to `account`. A third party can only pay gas to push. |
| Donation / forced ETH | OK | No `receive`. selfdestruct-forced value raises `receivedTotal` and becomes distributable. No accounting assumption breaks (`balance` is never compared for equality). |
| Access control on every mutator | OK | `onlyTimelock` (setSigners, setGuardian, setChallengePeriod), `onlyGuardianOrTimelock` (veto, pause, unpause). The rest are permissionless by design. Tests: `test_signer_rotation_only_via_timelock`, `test_guardian_and_period_only_timelock`. |
| Arithmetic | OK | 0.8 checked math. `cumulative <= claimed` is rejected before the subtraction (L339). |
| Initialization | OK | Constructor validates M≥3, 2≤K≤M, no zero or duplicate signers, bounded challenge period, non-zero timelock and guardian. Test `test_constructor_rejects_bad_sets`. |
| Upgradeability / proxy | N/A by design | Immutable, no delegatecall. A new version needs a new address plus a fork-config change (see §5). |
| Storage layout | N/A | No proxy. |
| EIP-712 domain (chainId, verifyingContract) | OK | OZ `EIP712("PRANA PotDistributor","1")` with a cached separator that is recomputed on chainId change. Test `test_signature_bound_to_chain_and_contract`. |
| Signature malleability | OK | OZ `ECDSA.recover` rejects high-s and bad v. Test `test_malleable_high_s_rejected`. |
| Duplicate signatures | OK | Strictly ascending recovered addresses (L215). Test `test_duplicate_signature_rejected`, `test_unsorted_signatures_rejected`. |
| Signature replay across rounds / signer sets | OK | `round` and `signerEpoch` are in the struct. Rotation clears the pending root (L299-306). Test `test_signer_rotation_only_via_timelock` (old sigs → UnknownSigner). |
| Mixed signatures over different digests | OK | Each signature is recovered against the one digest being posted, so a signature over another root recovers to a random address and is rejected. Test `test_malicious_root_cannot_reach_quorum`; devnet E2E. |
| ecrecover returning 0 | OK | OZ reverts on address(0). Also `isSigner[0]` can never be true. |
| Merkle second-preimage | OK | OZ double-hashed leaf `keccak(keccak(abi.encode(a,c)))`. Test `test_wrong_proof_and_wrong_amount` (inner node as leaf). |
| Merkle sorted-pair consistency off-chain | OK | `payout/merkle.py` mirrors OZ. Cross-checked live on the devnet: real claims with Python-built proofs succeed. |
| Double claim | OK | Cumulative model: `claimed[a]` is set to the cumulative amount. Tests `test_double_claim_and_cumulative_rounds`, devnet `claim.py` (second claim reverts). |
| Solvency | OK | `total ≤ receivedTotal` at post and at finalize. `totalClaimed + amount ≤ active.total` per claim (L341), so even a signed tree whose leaves over-sum the declared total pays out at most the total. Invariant `invariant_solvency`; test `test_leaves_exceed_declared_total_capped`. |
| Value conservation | OK | `invariant_conservation`: balance + totalClaimed == everything credited (256 runs × 64 depth, 0 reverts). |
| Early claim during the window | OK | Claims use only `active`. A pending root is activated only after `postedAt + challengePeriod`. Tests `test_post_window_finalize_claim`; devnet early-claim eth_call reverts. |
| Veto cannot be bypassed by re-posting | OK (after fix F-E2E-3) | `vetoedDigest` (postRoot / veto). |
| Veto | OK | Guardian or timelock, any time before finalization, including after the window while paused. The round number is not consumed. Tests `test_guardian_veto_then_repost_same_round`, `test_veto_after_window_but_before_finalize_while_paused`. |
| Pause cannot move funds | OK | Pause sets a flag only. No function sends value except the claims. Test `test_pause_blocks_claims_only_owner_cannot_withdraw`. |
| Admin withdrawal / arbitrary call | OK (absent) | No such function exists (Slither shows no `arbitrary-send` other than the proof-bound claim). |
| Timestamp dependence | Acceptable | Challenge window ≥ 1h vs ±15s miner drift (Slither `timestamp`, informational). |
| Strict equality on bytes32(0) | False positive | Slither `incorrect-equality` is on `root == 0` sentinels, not balances. |
| Inline assembly | Reviewed | `_send` uses `call(gas, to, amount, 0,0,0,0)`, which is memory-safe and copies no return data. Note: this also hides the call from Slither's `arbitrary-send-eth` and `reentrancy-eth` detectors, so the manual review above covers those classes. |
| Low-level call return value | OK | Checked: `claim` reverts and `claimMany` rolls back. |
| Unbounded `claimMany` input | OK | The caller pays its own gas. Items are independent. |
| Events for off-chain monitoring | OK | Posted, Finalized, Vetoed, Cleared, Claimed, PushFailed, Signers/Guardian/Period updates, Paused. |
| Centralization: timelock powers | **Finding C-1** | See below. |
| Centralization: liveness | **Finding M-1** | See below. |

## 3. Findings

### C-1 (High, centralization, off-contract): the DAO timelock is controlled by one EOA
- **Location:** constructor parameter `timelock_`, intended to be the mainnet `DAOTimelock`
  `0x574DeEaa82BcA4ACF6C5669D8dbe084C28EE0da4`.
- **Evidence (read-only, 2026-10-17):**
  - `getMinDelay()` = 172800 s (48 h).
  - `PROPOSER_ROLE` and `CANCELLER_ROLE` are held by the deployer EOA `0x026d…8d11`.
  - `EXECUTOR_ROLE` is held by anyone.
- **Impact:** if that EOA is compromised, the attacker can schedule `setSigners(attackerKeys)` and `setGuardian(attacker)`.
  48 h later they post a root paying themselves. Total exposure is the unclaimed pot.
- **Mitigations already in the design:**
  - The 48 h delay is public on-chain.
  - The current guardian can veto any root during the challenge window. However, after `setGuardian` executes,
    the old guardian has no power.
- **Recommendation:**
  1. Use a **dedicated** TimelockController for the pot whose PROPOSER is a 2-of-3 (or better) multisig of
     independent holders. Its CANCELLER should include the guardian multisig, and its `minDelay` should be at
     least 2× the challenge period.
  2. Alternatively, move the DAO timelock's PROPOSER to a multisig before F.
  3. Monitor `CallScheduled` on the timelock (runbook §Monitoring).

### M-1 (Medium, liveness): signers, guardian or timelock unavailable means payouts stall
- If fewer than K signers are online, no root is posted. A malicious guardian can veto forever.
- Funds are never lost: they stay in the contract.
- **Recovery paths:**
  - The timelock rotates signers or the guardian.
  - If the timelock itself is lost, funds are stuck permanently. This is a consequence of immutability.
- **Recommendation:** keep timelock control in a multisig with documented key-recovery.

### L-1 (Low): `PUSH_GAS` = 60k can be insufficient for exotic smart-wallet recipients
A third-party push then fails for that account. In `claimMany` it is skipped and rolled back; in `claim` it reverts.
The owner can always self-claim with all gas forwarded. Acknowledged.

### L-2 (Low): `_finalizeIfDue` returns false silently if `total > receivedTotal`
This is unreachable because `receivedTotal` never decreases (claims move value from balance to totalClaimed
one-for-one). Kept as defense-in-depth.

### I-1 (Info): devnet variant
`src/devnet/PotDistributorDevnet.sol` is generated by `sed` from the production file. It differs **only** in
`MIN_CHALLENGE` (60 s instead of 1 h) and the contract name (diff is in `devnet/up.sh` output). It must never be
deployed on mainnet.

### I-2 (Info): Slither results (15 after fixes, incl. `cyclomatic-complexity` on postRoot; full output in `contracts/slither.out`)
- `incorrect-equality` and `timestamp`: false positives (sentinel checks).
- `assembly`: the intentional `_send`.
- `pragma`: OZ `^0.8.20` vs ours `0.8.24`.
- `costly-loop`: totalClaimed writes in the claimMany loop (gas only).

Two earlier Slither items were **fixed**:
- `return-bomb`: `_send` no longer copies return data.
- `unindexed-event-address`: Guardian/Paused/Unpaused now index the address.

### F-E2E-1 (High, off-chain, FIXED): sampled PoW verification let a signer sign a forged round
- **What happened:** devnet run 1, round 2. A compromised coordinator published a bundle with ONE forged share
  among 1,972. signer1 checks 100% of shares and refused (`mixDigest mismatch`). signer2 was configured to
  sample 50% (`powSample 0.5`), missed the forged share, and **signed**.
- **Impact:** with a colluding malicious signer this reaches K=2 on a forged root. Only the guardian's veto
  would stop it.
- **Fix:** `signer.py` always verifies every share and refuses to start with `powSample != 1.0`. Measured cost: the
  devnet coordinator plus a signer checked 2,343 shares in under 8 s (Go, multi-core).
- **Evidence:** `/root/prana-payout/devnet-run1-sampling-finding.transcript`. Run 2 shows both honest signers refusing.

### F-E2E-3 (High, CONTRACT, FIXED): a vetoed root could be re-posted with its original signatures
- **What happened:** devnet run 3. The guardian vetoed round 3. The relayer later found the signer signature files
  for that same root, which are still valid (same round and signerEpoch), re-posted it, and it **finalized after
  the window**.
- **Impact:** a veto could be bypassed unless the guardian kept re-vetoing every window.
- **Fix:**
  - `veto()` stores the exact EIP-712 digest in `vetoedDigest`, and `postRoot` reverts `RootWasVetoed()` for it.
  - Signers also refuse to sign a vetoed root.
- **Tests:**
  - forge `test_vetoed_root_cannot_be_reposted_with_old_signatures`;
  - devnet run 4 `repost-vetoed-root` reverts;
  - transcript of the bypass: `/root/prana-payout/devnet-run3-veto-repost-finding.transcript`.

### F-E2E-4 (Info, test harness): invariant `per_account_cap` was too strict
In the colluding-signer over-allocation scenario, a later corrected root can offer an account *less* than it
already claimed. The contract handles this correctly: `claimed` stays and further claims revert `NothingToClaim`.
The invariant now bounds claims by the highest cumulative ever offered. It passed over 10 explicit fuzz seeds.

### F-E2E-2 (Medium, off-chain, FIXED): shares that found orphaned/uncled blocks were dropped
The block-share binding treated a block share that is not canonical as invalid, which removed a valid share from
its miner. It now counts as a normal share and is excluded only from the found-difficulty sum used by the luck check.

## 4. Off-chain trust boundary (outside the Solidity checklist)

| Threat | Control | Tested |
|---|---|---|
| Coordinator publishes a wrong root | Signers recompute independently and sign only on a byte-identical root. The coordinator has no key. | devnet: forged-share bundle refused by both honest signers |
| Coordinator injects a forged share | Independent Go Etchash verifier (`tools/sealhash`) in every signer. Its mainnet self-test verifies real blocks 1-3, 35000-35001 and 166500-166503. | unit + devnet |
| One malicious signer | K=2 of M=3. Its signature over another root recovers to garbage against the honest digest. | forge + devnet |
| Signer "signs what it is told" | Signer refuses unless all of the following hold: the inputs hash matches; endBlock and its hash match its own node; receivedTotal matches its own node; the previous state root equals the on-chain active root and its own stored state; the params equal its pinned params; PoW passes; the AI verdicts re-validate. | code + devnet |
| Silent re-weighting (aiWeight, unitDiff) by the coordinator | Signers pin params and reject any bundle whose params differ. | unit `test_rejects_param_reweighting` |
| Fabricated previous state | Signers use their own stored state, check it against the on-chain root, and replay published rounds against `RootFinalized`. | unit `test_rejects_forged_prev_state` |
| Signer equivocation | A signer refuses a second root for the same round unless the first was vetoed on-chain. | code |
| Shares on non-PRANA headers | Template binding is **not available**: core-geth's `pending` RPC block hides `miner`/`stateRoot`. Replaced by (a) block shares bound to canonical blocks by nonce+mixHash and (b) a luck check of claimed work vs found difficulty. **This is a statistical guard, not a proof.** | devnet |
| Duplicate / stale / forged share at the pool | oep duplicate set, 3-template backlog, Etchash verify, per-IP invalid-share policy. | devnet adversarial miner |
| Login spoofing / typo payouts | EIP-55 checksum required; pot and treasury denied. | devnet (6 cases) |
| AI Sybil / lazy worker / replay | Anchor rule, K-of-N, random assignment, one replica per address, strikes and a ban, one-round vesting of AI earnings with forfeiture on ban, job windows that cannot overlap. | unit + devnet |
