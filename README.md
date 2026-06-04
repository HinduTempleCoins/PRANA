<h1 align="center">PRANA</h1>

<p align="center">
  <b>An independent Proof-of-Work, Ethereum-compatible (EVM) blockchain.</b>
</p>

<p align="center">
  <!-- TODO: replace with the PRANA logo once designed -->
  <i>[ logo coming soon ]</i>
</p>

---

## What this is

PRANA is a private/independent **EVM chain** run from its own genesis, using **Ethash
Proof-of-Work**. It keeps full compatibility with the Ethereum developer ecosystem
(Solidity, OpenZeppelin, MetaMask, Hardhat/Foundry, explorers) while being a chain you run
and control yourself.

## Why core-geth (and why it can still do PoW)

Ethereum itself is no longer Proof-of-Work — at The Merge (Sept 2022) it moved to
Proof-of-Stake, and standard `go-ethereum` **removed its mining code** (per the official
Geth docs: *"geth is not able to seal Ethash or Clique blocks. It only works in PoS mode."*).

PRANA is therefore built on **[core-geth](https://github.com/etclabscore/core-geth)**, the
maintained `go-ethereum` fork that **kept Ethash PoW** and is designed for spinning up custom
chains from a genesis file.

## Repository layout

```
PRANA/
├── chain/                  # the L1 PoW node (core-geth fork)
│   ├── core-geth/          # forked client source (gitignored; rebuilt via scripts/build.sh)
│   ├── genesis/            # prana.genesis.json — Ethash PoW genesis, chainId 108369
│   └── scripts/            # build · init · run-miner · attach
└── tools/                  # local tooling
```

## Quick start (local dev chain)

> Requires Go and git. **Build note:** core-geth targets Go 1.21; a much newer Go (e.g. 1.26)
> fails to build it, so pin an older toolchain — Go auto-downloads it.

```bash
# 1. Build the node (forked core-geth)
cd chain/core-geth && GOTOOLCHAIN=go1.22.12 make geth && cd ../..

# 2. Initialize the chain from genesis
chain/scripts/init.sh

# 3. Start mining a local network (opens JSON-RPC on :8545)
chain/scripts/run-miner.sh

# 4. (optional) attach a console in another terminal
chain/scripts/attach.sh
```

**Connect a wallet (MetaMask):** Network name `PRANA`, RPC URL `http://127.0.0.1:8545`,
Chain ID `108369`, Currency symbol `PRANA`. A dev account is pre-funded in genesis — import
private key `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`.

> ⚠️ That dev key is **publicly known** (the standard Hardhat/Anvil test key) and is for
> **local development only**. Never use it — or any pre-funded dev account — on a real network.

## Status

Early build: the local PoW chain builds, initializes from genesis, and mines
(`eth_chainId` → `0x1a751`). More to come.
