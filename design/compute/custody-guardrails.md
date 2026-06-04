# Custody / Money-Transmitter Guardrails (off-chain pool mining external coins)

**Backlog item:** PR11 (`QUEUE-from-docs-8.md` §C).
**Source doc:** "PRANA — The Pool, Hardware Roles & The River" §7 / §8.
**Status:** guardrail / risk note. Not legal advice — flags the regulatory surface and the
engineering mitigations that shrink it. Consult counsel before operating any external-coin
pool that custodies value.

---

## 1. Where the risk actually is

The decentralized in-chain pool ([`decentralized-pool.md`](./decentralized-pool.md), PR6)
has **no custody problem for PRANA's own coin**: the
[`UnifiedSharesLedger`](../../contracts/contracts/compute/UnifiedSharesLedger.sol) mints and
pays miners directly, so no operator ever holds a miner's PRANA. That property is the
clean case.

The risk appears in the **other** mode (§7): when the **off-chain pool mines real external
coins** — Ethereum Classic (ETC), EthereumPoW (ETHW), or any external chain — *someone has
to hold the freshly-mined external coins between block-find and payout to miners.* Whoever
holds other people's value pending distribution is, in plain terms, custodying funds. In
many jurisdictions, receiving value and transmitting it to others can implicate
**money-transmitter / MSB** licensing regimes (in the US, FinCEN registration plus
state-by-state money-transmitter licensing; comparable regimes exist elsewhere). This is a
real regulatory surface, and it is exactly the surface the bootstrap pool
([`melek-bootstrap-pool.md`](./melek-bootstrap-pool.md), PR10) sits on.

The honest framing (§8): a pool that mines external coins and pays them out is doing
something that *looks like* money transmission, and we should design so that it isn't — or
so that the transmission runs through a properly licensed party — rather than pretend the
question away.

---

## 2. Mitigations (engineering + structural)

### a. Mine to contract-controlled / multisig-controlled addresses

Don't mine external coins into a personal hot wallet. Point external-coin block rewards at
an address controlled by code or by a multisig, so no single individual has unilateral
spending control and every movement is constrained by published rules. On an EVM external
chain (ETC/ETHW) this can be a smart contract; otherwise a multisig (e.g. a Safe-style
m-of-n). The goal: **custody is held by a governed mechanism, not a person.**

### b. Transparent multisig / DAO payout

Payout decisions flow through a **transparent multisig or the DAO**, not an operator's
discretion. Distribution amounts derive from the public share accounting (the SMT ledger on
MELEK during bootstrap; the on-chain shares ledger on PRANA). Every payout is a signable,
auditable, rule-bound action — not a manual transfer from a private wallet.

### c. Auditable accounting

The share record that determines who is owed what is **public and reconstructable**:
inputs (validated shares), the formula (PPLNS over a rolling window — the exact math in
`UnifiedSharesLedger`), and outputs (payouts) all reconcile. Anyone can verify that what
went out matches what was earned. Transparency is both a trust feature *and* part of the
regulatory posture (no opaque commingling).

### d. The integration-not-transmitter rule (the key structural mitigation)

**Route value through licensed rails; never become the unlicensed custodian.** If external
coins must be converted or paid out in a way that touches regulated money transmission,
**integrate with an entity that already holds the license** (a licensed exchange,
custodian, or payment processor) rather than building an in-house unlicensed money-transmission
service. The project *integrates* with licensed rails; it does not *become* the transmitter.
This is the difference between "we wrote software that talks to a licensed custodian" and
"we are the custodian" — the former is an integration, the latter is the regulated activity
we avoid.

---

## 3. The decentralized model eliminates this for PRANA's own issuance

Worth repeating because it's the cleanest mitigation of all: **for PRANA-native issuance
there is no custodian to license.** The
[`UnifiedSharesLedger`](../../contracts/contracts/compute/UnifiedSharesLedger.sol) holds the
PRANA budget *as a contract* and `claim(epoch)` pays the miner directly
(`prana.safeTransfer(msg.sender, paid)`); even the optional fee is taken inline to the
treasury with the net going to the claimant. A coordinator
([`CoordinatorRegistry`](../../contracts/contracts/compute/CoordinatorRegistry.sol)) is
never in the value path — its only role is getting verified shares recorded. So PRANA's own
pool has **no custody surface**; the guardrails above exist specifically for the
external-coin mode (bootstrap, and any later multi-coin mining of non-PRANA chains).

**Design implication:** prefer the native-issuance, contract-pays-directly model wherever
possible, and treat external-coin custody as a *bounded, guarded, temporary* arrangement
(bootstrap) rather than a permanent business line.

---

## 4. Checklist for any external-coin pool deployment

- [ ] External rewards mined to a contract- or multisig-controlled address (no personal hot
      wallet).
- [ ] Payouts authorized by multisig/DAO against public share accounting — no discretionary
      transfers.
- [ ] Share accounting public and reconcilable (inputs → PPLNS formula → outputs).
- [ ] Any conversion / fiat / cross-asset payout routed through a **licensed** exchange,
      custodian, or processor — integration, not in-house transmission.
- [ ] Legal review of the specific jurisdictions involved **before** custodying value.
- [ ] Documented sunset path to the custody-free PRANA-native pool once live.

---

## See also

- [`decentralized-pool.md`](./decentralized-pool.md) (PR6) — the custody-free native model.
- [`melek-bootstrap-pool.md`](./melek-bootstrap-pool.md) (PR10) — the bootstrap stage where
  external-coin custody is actually live and these guardrails bind.
