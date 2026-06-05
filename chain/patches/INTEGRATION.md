# Hathor Fees Module — core-geth integration steps

The Hathor Fees Module is consensus-critical: it takes Hathor's protocol fee off every
block's issuance, in the state transition every full node re-executes, so **no pool —
ours or a third party's — can bypass it**. This file lists the exact, mechanical steps to
wire the module into the core-geth source that `chain/scripts/build.sh` clones. The
load-bearing change (the reward split) is in
[`0001-hathor-fees-consensus.patch`](./0001-hathor-fees-consensus.patch); the steps here
add the genesis-config plumbing it reads.

> All paths below are inside the cloned core-geth tree (`chain/core-geth/`), not the
> PRANA repo root. `build.sh` runs these before `make geth` (see the patched build
> script).

## Step 1 — drop in the module package

Copy the PRANA module into core-geth's `params/` tree (so its import path becomes
`github.com/ethereum/go-ethereum/params/hathorfees`, which is what the patch imports):

```sh
mkdir -p chain/core-geth/params/hathorfees
cp chain/hathorfees/hathorfees.go        chain/core-geth/params/hathorfees/
cp chain/hathorfees/config.go            chain/core-geth/params/hathorfees/
cp chain/hathorfees/hathorfees_test.go   chain/core-geth/params/hathorfees/
```

(The package declares `package hathorfees` and imports only `common` + `uint256`, both
already in core-geth's module, so it builds in-tree with no go.mod changes.)

## Step 2 — apply the reward-split patch

```sh
cd chain/core-geth
git apply ../patches/0001-hathor-fees-consensus.patch
```

This edits `params/mutations/rewards.go::AccumulateRewards` to split the fee off the
winner's reward and credit `hathorFee.FeeAddress` before crediting the sealer. It reads
the config through a narrow interface (`interface{ GetHathorFee() *hathorfees.Config }`),
so steps 3–4 only need to make the chain-config type satisfy that interface.

## Step 3 — add the field to the config types

Add a `HathorFee` field and a `GetHathorFee()` accessor so the configurator exposes it.

**3a. `params/types/coregeth/chain_config.go`** — add to the `CoreGethChainConfig` struct
(near the other consensus-engine fields):

```go
// HathorFee carries the PRANA Hathor Fees Module parameters (Devcoin-style protocol
// fee on block issuance). Nil => module disabled (backward compatible with stock geth).
HathorFee *hathorfees.GenesisConfig `json:"hathorFee,omitempty"`
```

with the import `hathorfees "github.com/ethereum/go-ethereum/params/hathorfees"`.

**3b. `params/types/coregeth/chain_config_configurator.go`** — add the accessor:

```go
func (c *CoreGethChainConfig) GetHathorFee() *hathorfees.Config {
    return c.HathorFee.ToConfig()
}
```

(`ToConfig()` on a nil `*GenesisConfig` returns nil — disabled. Safe.)

## Step 4 — forward the accessor from the genesis wrapper

The reward path receives the configurator as `*genesisT.Genesis` in some call sites.
In **`params/types/genesisT/genesis.go`** add the forwarder (next to the existing
`GetEthashECIP1017Transition` forwarder around line 1076):

```go
func (g *Genesis) GetHathorFee() *hathorfees.Config {
    return g.Config.GetHathorFee()
}
```

Do the same on the `goethereum` config type
(`params/types/goethereum/goethereum_configurator.go`) if a PRANA chain is ever launched
from a `ChainConfig` rather than a `CoreGethChainConfig`; for PRANA's core-geth genesis
(step 5) the coregeth type is the one used.

## Step 5 — genesis JSON

The fee parameters are read from the `"hathorFee"` object under `"config"` in
`chain/genesis/prana.genesis.json` (already added in this repo). Shape:

```json
"hathorFee": {
  "feeBps": 500,
  "feeAddress": "0x000000000000000000000000000000000048a740",
  "activationBlock": 0
}
```

- `feeBps`: Hathor's share in basis points (500 = 5.00%). **OPEN: operator sets the
  number.** Placeholder is 500.
- `feeAddress`: the protocol beneficiary. **Intended: the deployed `HathorFeeTreasury`
  contract address.** The placeholder is a deterministic non-zero stub; replace at
  genesis-prep with the real treasury address (or a genesis-`alloc`'d precompile-style
  address). Must be non-zero, or `ValidateBlockFee` returns `ErrNoFeeAddress`.
- `activationBlock`: first height the fee applies (0 = from genesis).

## Step 6 — build & test

```sh
cd chain/core-geth
go test ./params/hathorfees/...     # module unit tests
go build ./...                      # whole tree, incl. patched rewards.go
make geth
```

A node built this way credits Hathor her share on every block by consensus. A node that
runs WITHOUT this change computes a different state root and forks itself off the PRANA
network — which is exactly the un-bypassable property: honest majority enforces the fee.

## What is consensus-critical (do not change without a hard fork)

- `hathorfees.Config.Split` — the exact integer math of the split.
- The call site in `AccumulateRewards` — order and rounding.
- `feeBps` / `feeAddress` / `activationBlock` in genesis — every node must run identical
  values. Changing `feeBps` after launch is a hard fork (coordinate height-gated, the way
  `EthashBlockRewardSchedule` height-gates reward changes).
