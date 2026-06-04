# Echidna property harness

`EchidnaBurnMine.sol` is a property-based fuzzing harness for the `BurnMine` burn-to-mint sink.

**Status:** the echidna binary is **not installed** in this environment. The config
(`../../echidna.yaml`) and the property contract here are ready to run as soon as it is.

## Run (once echidna is installed)

```bash
# from contracts/
echidna . --contract EchidnaBurnMine --config echidna.yaml
```

Echidna is a Haskell tool; install via the prebuilt release binary
(`crytic/echidna` GitHub releases) or `docker run ghcr.io/crytic/echidna`.

## Properties asserted (all must always hold)

1. `echidna_mine_holds_no_input` — the mine never retains input tokens (true pass-through sink).
2. `echidna_input_supply_conserved` — `input.totalSupply + totalBurned == initial faucet` (burn is real).
3. `echidna_output_supply_equals_minted` — `output.totalSupply == mine.totalMinted` (no phantom mint).
4. `echidna_minted_within_ratio` — `totalMinted <= totalBurned * num / den` (ratio ceiling).
5. `echidna_counters_monotonic` — `totalBurned`/`totalMinted` never decrease.

The harness deploys its own burnable input + mintable output token and the `BurnMine` in its
constructor, then is itself the sole fuzzed caller (pre-funded + pre-approved). The
`mineSome(uint256)` action bounds the fuzzed amount to the affordable balance.

These mirror the Hardhat invariant tests in `test/invariants/` (BurnMineInvariant) and the
Foundry invariant in `test-forge/invariant/`, giving a third independent property engine.
