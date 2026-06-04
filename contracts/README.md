# Contracts

A library of generic, chain-agnostic EVM smart contracts covering common DeFi, NFT,
governance, and utility primitives. They are built on [OpenZeppelin](https://www.openzeppelin.com/)
v5, written in **Solidity 0.8.24** targeting the **London** EVM, and developed/tested with
[Hardhat](https://hardhat.org/). Because they avoid chain-specific assumptions, they compile
and run on any EVM network — a local dev chain today, or any production target later.

Each contract implements a single, well-known mechanism (a token template, an AMM pool, a
staking gauge, a vesting schedule, etc.) and is meant to be composed rather than configured
into one monolith. Interfaces for the cross-contract integration points live in
[`contracts/interfaces/`](contracts/interfaces).

## Catalog

### Tokens & token engine
| Contract | Description |
|----------|-------------|
| `ERC20Base` | Configurable ERC-20 template (burnable, capped, pausable, permit, role-gated mint) used by the factory wizard. |
| `ERC20FactoryWizard` | One-call deploy wizard that creates and hands ownership of a live `ERC20Base` token. |
| `ERC1155Base` | Role-gated mintable, holder-burnable ERC-1155 multi-token. |
| `UtilityToken` | Generic burnable fee/utility ERC-20 consumed to pay for on-chain services, with per-spender allowances. |
| `BondingCurveToken` | ERC-20 minted/burned against a reserve token along a linear bonding curve. |
| `MineableERC20` | EIP-918-style proof-of-work mineable ERC-20 (rotating challenge, mint-on-solution). |
| `EquityDividendToken` | ERC-20 "share" token whose holders accrue dividends paid in another ERC-20. |
| `WrappedNative` | WETH9-style canonical wrapper for the native coin (deposit/withdraw, ERC-20 interface). |

### AMM & markets
| Contract | Description |
|----------|-------------|
| `PeggedSwapPool` | Constant-sum AMM for two tokens assumed to trade 1:1, with LP shares. |
| `DutchAuction` | Linear declining-price auction for a single ERC-721, settled in an ERC-20. |
| `RoyaltyMarketplace` | Fixed-price ERC-721 sales settled in an ERC-20, with escrow and EIP-2981 royalty payout. |
| `LiquidityLocker` | Time-locks LP / ERC-20 tokens until an unlock time (anti-rug). |

### Burn & utility sinks
| Contract | Description |
|----------|-------------|
| `BurnMine` | Immutable fixed-ratio burn-to-mint: burn an input token, mint an output token at `amountIn * num / den`. |
| `BurnForHashrate` | Virtual-mining model — burn a token for proportional, time-decaying virtual hashrate / reward share. |
| `UsageBurn` | Burn-to-use metering — burn tokens to record/authorize a unit of on-chain usage. |
| `ProofOfBurnRegistry` | Generic append-only ledger of burn receipts. |
| `FeeCollectorBurner` | Collects protocol fees and sweeps them to a burn. |
| `FeeRouter` | Routes an incoming fee token to a fixed set of destinations by basis points. |
| `RevenueSplitter` | Immutable pull-based percentage split of incoming funds across recipients. |
| `AccessGate` | Burn-for-access subscription/bond gate granting time-bound access. |

### Emissions, DAO & governance
| Contract | Description |
|----------|-------------|
| `GovernanceToken` | ERC-20 with on-chain voting power (`ERC20Votes` + permit). |
| `GovernorDAO` | OpenZeppelin/Compound-style on-chain governor (propose/vote/queue/execute). |
| `VoteEscrow` | Lock a token for time-decaying voting weight (veCRV model, simplified). |
| `GaugeController` | ve-weighted emission direction across gauges (Curve model, simplified). |
| `LiquidityGauge` | Stake LP tokens to earn rewards over time (Synthetix StakingRewards model). |
| `EmissionScheduler` | Per-epoch emission with optional halving, pushed to a distributor. |
| `SupplyController` | Role-gated minting with a hard per-epoch cap. |
| `PoLToken` | Mintable/burnable ERC-20 reward token, `MINTER_ROLE`-gated, zero initial supply. |
| `DividendDistributor` | Stake an equity token to earn a pro-rata share of distributed fees. |

### Lending & vaults
| Contract | Description |
|----------|-------------|
| `CDPVault` | Minimal overcollateralized borrow vault (Maker/Aave model) against an oracle price. |
| `InterestRateModel` | Jump-rate interest model (Compound/Aave style). |
| `ERC4626Vault` | Minimal ERC-4626 tokenized vault (deposit underlying, receive shares). |
| `TimelockVault` | Per-user time-locks releasing ERC-20 tokens after an unlock time. |
| `NoLossLotto` | No-loss prize-savings pool (PoolTogether model). |

### NFT & game
| Contract | Description |
|----------|-------------|
| `PranaNFT` | Role-gated mintable ERC-721 with per-token URIs. |
| `RoyaltyNFT` | Role-gated mintable ERC-721 with per-token URIs and EIP-2981 royalties. |
| `CreatureNFT` | Breedable ERC-721 with on-chain creature traits/genetics. |
| `GachaMint` | Commit-reveal gacha minting an ERC-721 of disclosed rarity, paid in an ERC-20. |
| `ERC721Staking` | Stake NFTs to earn a fixed ERC-20 reward per NFT per second. |
| `SeasonPass` | Tiered battle-pass with non-rollover reward claims. |
| `SubscriptionLockNFT` | Time-bound NFT membership keys (Unlock Protocol model). |

### Distribution, payments & access
| Contract | Description |
|----------|-------------|
| `MerkleDistributor` | Claimable ERC-20 airdrop gated by a Merkle allowlist. |
| `MerkleClaimDeadline` | Merkle airdrop with a hard claim deadline and post-deadline owner sweep. |
| `BatchAirdrop` | Stateless push distributor — pull a total and fan out to many recipients. |
| `TokenVesting` | Linear token vesting with an optional cliff. |
| `StreamingPayments` | Sablier-style linear token streams from a locked balance. |
| `Escrow` | Two-party ERC-20 escrow with a neutral arbiter. |
| `CrowdfundEscrow` | Kickstarter-style all-or-nothing crowdfund in an ERC-20. |
| `ContributionBountyEscrow` | Escrow that pays out for off-chain-verified contributions/bounties. |
| `SignedMintAuthorizer` | Mint gate redeeming off-chain signed vouchers. |
| `SessionKeyGrant` | Scoped, capped, expiring authorizations (on-chain session keys). |
| `VerifyingPaymaster` | Signature-based gas-sponsorship paymaster abstraction. |

### Compute & oracles
| Contract | Description |
|----------|-------------|
| `ComputeJobMarket` | Off-chain compute job board with on-chain escrow and oracle-attested results. |
| `AttestationStakeSlash` | Shared stake-and-slash module for oracle attestors. |
| `ProofOfSolarOracleMint` | Attested-metric → mint with an attestor allowlist and per-epoch cap. |
| `EnergyGasAccountant` | Staked, regenerating-energy accounting model for metering on-chain actions. |
| `SimplePriceOracle` | Role-fed price source (dev/test stand-in for an external oracle). |
| `TWAPOracle` | Manipulation-resistant time-weighted average price accumulator. |

### Infrastructure
| Contract | Description |
|----------|-------------|
| `MultiSigWallet` | Minimal m-of-n multisig for a treasury / owner key. |
| `Multicall` | Multicall3-style stateless batched call aggregator. |

## Develop & build

```bash
cd contracts
npm install
npm run build     # hardhat compile
npm test          # hardhat test
```

## Deploy

Point Hardhat at your target RPC and provide a funded deployer key, then run the deploy
script:

```bash
DEPLOYER_KEY=0x<your-funded-dev-key> npm run deploy:local
```

> Use a throwaway development key for local networks only — never use a development key on a
> real network.

## Design notes
- **No premine:** reward tokens start at zero supply and are minted only by authorized modules.
- **Single-purpose & composable:** each contract does one thing; build flows by wiring
  contracts together rather than configuring a monolith.
- **Immutable where it matters:** sinks like `BurnMine` ship with no admin, pause, or upgrade
  path, so they are easy to audit and cannot be reconfigured after deploy.
- **Solidity 0.8.24 / London EVM** for broad compatibility across EVM fork sets.
