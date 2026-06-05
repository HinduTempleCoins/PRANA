# Hathor Fees Module (consensus-level)

The **un-bypassable** PRANA protocol fee. A fraction of every block's issuance is paid,
by consensus rule, to Hathor's fee address — modeled on Devcoin's protocol-level receiver
payout. This is **distinct from** the application-layer skim
(`contracts/compute/SettlementFeeHook.sol` + `HathorFeeTreasury.sol`), which only bites
when value leaves the on-chain `UnifiedSharesLedger`. A third-party pool that never
touches our ledger and settles miners off-chain pays **no** application-layer skim — but
it still pays **this** one, because the fee is taken at block issuance, in the state
transition every full node re-executes. There is no PRANA in existence that did not pay
the fee at the moment it was minted.

## Files

- `hathorfees.go` — `Config` (fee bps / address / activation), `Split()` (the consensus
  math), `ValidateBlockFee()` (the explicit block-validity rule).
- `config.go` — `GenesisConfig` (the `"hathorFee"` JSON shape) → `Config`.
- `hathorfees_test.go` — split math, activation gating, and the validity rule
  (short fee = invalid; zero fee = invalid; overpay = ok).

## How it is enforced

The split runs inside `params/mutations/rewards.go::AccumulateRewards` (wired by
`chain/patches/0001-hathor-fees-consensus.patch`). The resulting balances feed the block's
state root. A miner who omits or short-pays the fee produces a different state root than
honest nodes compute, so the block is rejected. The fee is a block-validity rule, not a
request.

## Wiring it into a build

See [`../patches/INTEGRATION.md`](../patches/INTEGRATION.md). `chain/scripts/build.sh`
copies this package into the cloned core-geth tree and applies the patch automatically;
the small genesis-config accessor (`GetHathorFee()`) is the one manual step, documented
there.

## Operator knobs (genesis)

`feeBps` (the percentage — **operator sets the number**), `feeAddress` (intended: the
deployed `HathorFeeTreasury`), `activationBlock`. Changing `feeBps` after launch is a hard
fork.
