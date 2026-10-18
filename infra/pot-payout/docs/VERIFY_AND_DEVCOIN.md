# What anyone can verify, and the DevCoin lessons applied

## Round publication (`<publishUrl>/round_<N>/`)
| file | content |
|---|---|
| `inputs.json` | Canonical JSON bundle. Its sha256 is the on-chain `inputsHash` (in `RootPosted`). It contains: the block range, block hash and timestamps; `receivedTotal`; pinned params; the previous state; every accepted share; every verified AI job with all replicas' outputs; exclusions. |
| `proposal.json` | {round, root, total, inputsHash, endBlock} |
| `round.json` | Cumulative per address, Merkle proofs, units per address, held AI earnings, banned workers |
| `receiver_N.csv` | Devcoin-style list: address, cumulative, this-round hash pay, released AI, held AI |

## What an outsider can check, with only a PRANA node, the published files and this repo
1. **The bundle is the one that was signed.** sha256(inputs.json) == `inputsHash` in the `RootPosted` event.
2. **The money is real.** `receivedTotal` == `eth_getBalance(pot, endBlock)` + `totalClaimed()` at endBlock.
   The fork credits the pot 98% of each block reward plus uncle rewards. Every block from F on can be checked:
   Δpot = 1.96 PRANA (+ uncle rewards), Δtreasury = 0.04, Δsealer = gas fees only.
3. **Every share is real work at its claimed difficulty.**
   - Run `shareverify shares -fblock 40000 -mindiff <poolDiff>` (Go; an independent implementation of Etchash
     plus the seal hash).
   - It recomputes hashimoto(hashNoNonce, nonce) on the epoch's light cache for `height`, requires
     mixDigest equality, and requires result ≤ 2²⁵⁶/diff.
   - The verifier was self-tested against real mainnet blocks 1-3, 35000-35001 and 166500-166503 (all OK). It also
     showed that mainnet's ECIP-1099 activation is **40000**. With 0, blocks 35000/35001 fail, so the
     `ecip1099FBlock: 0` in `ACTIVE.json` is stale.
4. **Shares that found blocks are on-chain.** A share flagged `block` must equal the canonical block's nonce and
   mixHash at that height; otherwise it is an orphan and counts as a normal share.
5. **Luck.** Claimed share work vs block difficulty the pool actually found. A pool, or an insider, that credits
   shares mined on non-PRANA headers cannot produce blocks from them, so luck collapses and signers refuse
   (luckMin 0.25 once ≥ 20 blocks are expected).
   - **Limit (honest statement):** this is statistical. Per-share template binding was built in the pool patch
     (`templateBinding`) but **does not work** against core-geth today: `eth_getBlockByNumber("pending")`
     returns `miner: null` and `stateRoot: 0x0`, so the pool cannot rebuild the header.
   - Making it exact needs a node-side RPC that returns the sealing header (fork-side follow-up; not done).
6. **Every AI credit is earned.** For each job the bundle has: type, model sha256 (must be pinned), input and
   params (with their hashes), every worker's full output and output hash, verdicts, K, credited set and milliWU.
   An outsider recomputes output hashes from outputs and checks that:
   - the credited workers equal the agreeing set;
   - the agreeing set is at least K and contains a trusted anchor;
   - struck workers really disagree;
   - milliWU follows the type rule.

   With the Hathor-0 bundle they can also **re-run** the job (`verify.Hathor0Rerun`).
7. **The math.** `roundlib.compute_round(inputs, params, prevState)` is deterministic. Running it gives the
   same root. Previous states chain back to round 1 and each matches a `RootFinalized` event.
8. **Lost-and-Found.** The `blocks` array in inputs.json lists every block in the round with its header coinbase,
   uncle coinbases and attributed amounts. Recompute it from any node: Δ(balance + totalClaimed) per block, split
   with the era-0 formula. Outside-coinbase amounts appear only under that coinbase, never in share pay. They are
   released only in a round where that same address has a valid pool share.
9. **Payouts.** `Claimed(account, amount, cumulative, round)` events. For every account,
   `claimed[a]` ≤ its cumulative in the active root.

**What an outsider cannot verify:**
- *Which* stratum login submitted a share. That is inherent to every pool, Devcoin included. Mitigation: each
  miner can check that its own nonces appear under its login in `inputs.json`; the pool cannot omit or
  re-attribute them without the miner seeing it.
- That the AI job *inputs* came from real Hathor services rather than synthetic jobs. Credit per job is still
  bounded by the K-of-N plus anchor rule, and the job list is public.

## DevCoin problems we do not replicate
| DevCoin / DevTome | here |
|---|---|
| Receiver list (`receiver_N.csv`) fetched over HTTP from a **majority of mirror sites**; whoever controls the mirrors controls payouts | The payout list is a Merkle root posted on-chain with **K-of-M EIP-712 signatures**. Each signer recomputed it independently from public inputs and its own chain node. Mirrors are irrelevant: the bundle is content-addressed (sha256 on-chain). |
| Consensus code trusted an off-chain file (the receiver list) | Consensus trusts **nothing** off-chain. It pays one hardcoded address. All judgement happens in an immutable contract with on-chain-checkable rules (quorum, solvency, window). |
| A single bookkeeper (Unthinkingbit) computed shares | Coordinator has **no key and no power**. A wrong proposal just never gathers K signatures (proven on the devnet). |
| No challenge period | A posted root waits ≥ 1 h (mainnet suggestion 12 h). The guardian can veto, the round is recomputed, and claims can be paused (pause cannot move funds). |
| Generation-share accounting off-chain only | Cumulative claimed[] on-chain, so double-claim is impossible, and `totalClaimed ≤ root total ≤ receivedTotal` is enforced on-chain. |
| Upgrades by changing the list format | Immutable contract. A new version needs a new address plus a fork-config change (deliberate and visible). |
