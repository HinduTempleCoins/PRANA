# Data-DAO — community-owned, licensable verified datasets (AG8 / AG9)

> Round 9, AI/GridCoin doc §9. Implemented by
> [`contracts/contracts/DataDAO.sol`](../../contracts/contracts/DataDAO.sol).
> Tests: [`contracts/test/DataDAO.test.js`](../../contracts/test/DataDAO.test.js).
> Reads from the human-contribution suite spec'd in
> [`platform-spec.md`](./platform-spec.md) (AG1–AG5).

---

## 1. What it is, in one breath

The Data-DAO turns the verified-human corpus produced by the Human-Training platform into a
**community-owned asset** and a **settlement rail**. It does two things and nothing else:

1. **Records provenance.** Each accepted contribution becomes an on-chain record
   `{contributor, datasetId, weight, verifiedHuman, timestamp}`, accumulating that
   contributor's share of a dataset.
2. **Licenses + pays out.** An outside AI builder / researcher pays to license a dataset;
   the payment is escrowed and split **pro-rata to that dataset's contributors by their
   accumulated weight**, minus an optional protocol cut to the DAO treasury. Contributors
   **pull** their share.

It is the on-chain *ledger of ownership* over the corpus and the *cash register* that
distributes licensing revenue. It does **not** store the data (that lives off-chain,
referenced by `termsHash` / dataset metadata) and does **not** itself verify humanity — it
reads that from the credentialing module.

---

## 2. Why the verified-human provenance is the moat

The open web is filling with bot- and agent-generated survey fraud and synthetic text.
Buyers training models increasingly cannot trust scraped or crowd-sourced data to be
human-authored. A corpus where **every** contribution carries a chain-attested
verified-human provenance flag (set by `ProofOfHumanCredential`, AG4) is a *defensibly
clean* training set — the one thing the open scrape cannot provide. That flag, recorded at
contribution time and visible to buyers, is the whole value proposition: **verified humans
produce the premium product, and the chain proves it.**

Because ownership is recorded per contributor and proceeds flow back pro-rata, a
contributor is paid **twice**: once at credit time (pool shares, platform §5) and again, on
an ongoing basis, as a slice of every license sale their data is part of. The dataset is
simultaneously the moat and the product, and the people who built it own it.

---

## 3. The split math (exact)

The naive design — loop over all contributors at license time and push each their cut — is
a **gas bomb**: a 10,000-contributor corpus would be unlicensable, and one reverting/hostile
payee could block the whole distribution. Data-DAO instead uses the **MasterChef
"reward-per-share" accumulator**, identical in spirit to the repo's existing
`RevenueSplitter` / `DividendDistributor` pull-split, generalized to *per-dataset,
per-pay-token* accounting.

Per `(datasetId, payToken)` the contract keeps one number:

```
accRewardPerWeight   // cumulative payout per unit of weight, scaled by ACC = 1e18
```

**On license** (one buyer pays `price`):

```
cut      = price * protocolFeeBps / 10000      // to treasury (pull)
toSplit  = price - cut
accRewardPerWeight += toSplit * ACC / totalWeight   // O(1): only the index moves
```

**A contributor's claimable** (pull pattern):

```
accrued    = weight * accRewardPerWeight / ACC
owed       = accrued - rewardDebt[contributor]       // since they last settled
claimable  = pending[contributor] + owed
```

**On claim** the owed amount is moved into `pending`, `pending` is zeroed *before* the
external transfer (checks-effects-interactions → reentrancy-safe), and `rewardDebt` is
re-based to the current index.

Both license and claim are **O(1)**. No loop over contributors exists anywhere.

### Worked example (the test case)

Two contributors, weights 60 and 40 (`totalWeight = 100`). Protocol cut = 10%. A builder
licenses for `price = 1,000,000`:

```
cut     = 100,000        → treasury
toSplit = 900,000        → split across weight 100  (perWeight += 9,000 * ACC/ACC scaled)
Alice (60): 900,000 * 60/100 = 540,000
Bob   (40): 900,000 * 40/100 = 360,000
```

Each pulls their share; double-claim reverts (`NothingToClaim`).

### Late-joiner correctness

A contributor credited **after** a license sale must not retroactively claw back proceeds
from licenses sold before they existed (that would steal from earlier licensees' splits and
break solvency). The accumulator handles this for free: a new contributor's `rewardDebt` is
initialized to `weight * accRewardPerWeight` at the moment they are credited, so they only
ever earn from index increases (license sales) that happen **after** they joined.
`recordContribution` settles the contributor's pending amount and re-bases their debt before
bumping weight, so a weight increase mid-stream is also exact.

---

## 4. How it binds the human-contribution provenance

```
HumanTaskCreditor (AG5, == TaskLaneCreditor)
   │  holds CURATOR_ROLE on DataDAO
   │  after a contribution clears verification + the human/rep gates:
   ▼
DataDAO.recordContribution(datasetId, contributor, weight, verifiedHuman)
   │  if humanVerifier set:  cross-check verifiedHuman against
   │     ProofOfHumanCredential.isVerifiedHuman(contributor)   ← the moat, on-chain
   ▼
 {contributor, datasetId, weight, verifiedHuman, timestamp}  → provenance log
 contributionWeightOf[datasetId][contributor] += weight
 totalWeight[datasetId]                        += weight
```

- **`CURATOR_ROLE`** is the integration seam. In production it is granted to the
  **HumanTaskCreditor** (AG5) — the same module that credits the compute/contribution pool
  (`TaskLaneCreditor.sol`). The creditor is the single authority that has already run the
  contribution through verification (`TaskVerificationGate`), the reputation gate
  (`ReputationRegistry`, AG3) and the human gate (`ProofOfHumanCredential`, AG4) before it
  records ownership here. Unauthorized `recordContribution` reverts.
- **`humanVerifier` (optional)** is a defense-in-depth cross-check. When the
  `ProofOfHumanCredential` module ships, the DAO points DataDAO at it via `setHumanVerifier`;
  thereafter a contribution claimed as `verifiedHuman=true` is *also* checked against the
  live credential and reverts (`NotVerifiedHuman`) if the contributor is not in fact verified.
  Until then (`address(0)`) DataDAO trusts the curator's flag — acceptable because the curator
  *is* the gate. The minimal interface is declared locally:

  ```solidity
  interface IHumanVerifier { function isVerifiedHuman(address) external view returns (bool); }
  ```

  This is the ONLY surface DataDAO needs from AG4; it does not depend on the rest of the
  human suite's shape, so the two can be built independently.

> **Integration note (build order):** at authoring time the
> `contracts/contracts/human/` suite (`ProofOfHumanCredential`, `ReputationRegistry`,
> `HumanTaskCreditor`) did not yet exist in the repo — a sibling agent is building it
> (task AG-HUMAN). DataDAO therefore references the credentialing module by the minimal
> `IHumanVerifier` interface above and is wired to it optionally. A test-only
> `MockHumanVerifier` stands in for the cross-check tests. When the suite lands: (a) grant
> `CURATOR_ROLE` to the deployed HumanTaskCreditor, (b) call `setHumanVerifier(<AG4 addr>)`
> if AG4 exposes `isVerifiedHuman(address)` (or add a thin adapter if its method name
> differs). No DataDAO code change is required for either step.

---

## 5. The proceeds-to-contributors flow (end to end)

```
 outside AI builder / researcher
        │  license(datasetId)  +  price (native PRANA or ERC-20)
        ▼
   ┌──────────── DataDAO ────────────┐
   │  protocol cut → protocolFees     │ ── DAO withdrawProtocolFees → treasury
   │  remainder    → accRewardPerWeight (index bump, O(1))           │
   └──────────────────────────────────┘
        │  (escrowed; nothing pushed)
        ▼
   contributors pull:  claim(datasetId, payToken, contributor)
        │  pro-rata to accumulated weight
        ▼
   verified-human contributors who built the corpus get paid — again
```

- **Registry of datasets.** Many datasets coexist; each has its own `payToken`, `price`,
  `termsHash` (hash of the off-chain license agreement) and open/closed flag. The DAO
  (`DAO_ROLE`) opens datasets and sets terms; per-license terms are captured by `termsHash`
  and emitted on every `DatasetLicensed`.
- **Pay token.** Each dataset is priced in native PRANA (`address(0)`) **or** an ERC-20.
  Money paths use `ReentrancyGuard` + `SafeERC20`; native datasets require exact `msg.value`.
- **Protocol cut.** Optional `protocolFeeBps` skim to the DAO treasury, pulled separately so
  it never blocks contributor claims.

---

## 6. Interface surface

**Views**
- `contributionWeightOf(datasetId, contributor)` — accumulated weight.
- `totalWeight(datasetId)` — sum across contributors.
- `claimable(datasetId, payToken, contributor)` — pull-able proceeds.
- `licenseInfo(datasetId)` — `exists, open, payToken, price, termsHash, totalWeight, licensesSold`.
- `contributions(i)` / `contributionCount()` — the append-only provenance log.

**Events**
- `ContributionRecorded(datasetId, contributor, weight, verifiedHuman, newTotalWeight, idx)`
- `DatasetLicensed(datasetId, licensee, payToken, amount, protocolCut, termsHash)`
- `ProceedsClaimed(datasetId, payToken, contributor, amount)`
- plus `DatasetCreated/TermsUpdated/OpenSet`, `ProtocolFeesWithdrawn`, config events.

**Custom errors:** `UnknownDataset`, `DatasetExists`, `DatasetClosed`, `ZeroAddress`,
`ZeroWeight`, `ZeroPrice`, `NotVerifiedHuman`, `WrongPayment`, `NativeNotAccepted`,
`NothingToClaim`, `FeeTooHigh`, `NativeSendFailed`.

**Roles:** `DEFAULT_ADMIN_ROLE` + `DAO_ROLE` (governance), `CURATOR_ROLE` (the
HumanTaskCreditor).

---

## 7. Security properties

- **Gas-bomb-proof split** — O(1) license + claim, no contributor loop (MasterChef index).
- **Pull-payment** — funds only ever leave to the named `contributor` / `treasury`; a
  hostile payee can only block their own claim, never the distribution or other payees.
- **Reentrancy-safe** — `nonReentrant` on every money path; pending zeroed before send (CEI).
- **Solvency** — `sum(claimable) + protocolFees == escrowed balance` per pay token; late
  joiners cannot draw on pre-join proceeds (debt initialized at the current index).
- **No forged provenance** — only `CURATOR_ROLE` records; `verifiedHuman=true` is
  cross-checked against the live credential when the verifier is configured.
```
