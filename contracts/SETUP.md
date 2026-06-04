# PRANA contracts — toolchain setup (Foundry + Hardhat, side by side)

This directory carries **two** test toolchains over **one** shared Solidity source tree
(`contracts/contracts/`):

| Toolchain | Tests dir    | Build output            | Config            |
|-----------|--------------|-------------------------|-------------------|
| Hardhat   | `test/`      | `artifacts/`, `cache/`  | `hardhat.config.js` |
| Foundry   | `test-forge/`| `out-forge/`, `cache-forge/` | `foundry.toml`  |

The Foundry output dirs are deliberately named `out-forge` / `cache-forge` so forge can **never**
clobber Hardhat's `artifacts/` and `cache/`. Both compile with **solc 0.8.24**, **optimizer on
(200 runs)**, **evm_version = london** — kept in lockstep so the same bytecode comes out of either
toolchain (London matches the local Ethash PoW chain's fork set, chainId 108369).

## Install Foundry

Foundry is not bundled with the Codespace. Install it once:

```bash
curl -L https://foundry.paradigm.xyz | bash
~/.foundry/bin/foundryup
```

`foundryup` drops `forge`, `cast`, `anvil`, `chisel` into `~/.foundry/bin`. That dir is not always
on `PATH` in a fresh shell, so either `source ~/.bashrc` / open a new terminal, or rely on the
`Makefile`, which resolves `forge` from `~/.foundry/bin` automatically.

Verified working with **forge 1.7.1** and **forge-std 1.16.1** (vendored in `lib/forge-std/`).

> If `foundryup` cannot run in your environment, the configs can still be validated by inspection:
> `foundry.toml` and `remappings.txt` are plain key=value and reference deps that already exist
> (`node_modules/@openzeppelin`, `lib/forge-std`). In this setup the install succeeded and the
> forge suite runs green — see "Running" below.

## Layout

```
contracts/
├── foundry.toml            # forge profile (src=contracts, test=test-forge, out=out-forge, …)
├── remappings.txt          # forge remappings (NO comments — forge's parser rejects them)
├── hardhat.config.js       # untouched Hardhat config
├── Makefile                # test / test-forge / test-hardhat / coverage / fmt-check / fmt / snapshot
├── .gas-snapshot           # forge gas snapshot (committed; refresh with `make snapshot`)
├── lib/forge-std/          # forge standard test lib (the ONLY thing vendored under lib/)
├── contracts/contracts/    # shared Solidity sources (Create2Deployer.sol lives here)
├── script/                 # forge scripts (Create2Deployer.s.sol)
└── test-forge/
    ├── Create2Deployer.t.sol
    ├── SALTS.md            # CREATE2 salt registry
    ├── helpers/            # BaseTest.sol, Fixtures.sol (forge-only test fixtures)
    └── invariant/          # BurnMineInvariant.t.sol (stateful invariants)
```

## Running

```bash
make build          # forge build
make test-forge     # forge tests only
make test-hardhat   # hardhat (mocha) tests only
make test           # both
make coverage       # forge coverage
make fmt-check      # forge fmt --check (CI gate)
make snapshot       # refresh .gas-snapshot
```

Current state: **`forge build` + `forge test` pass — 12 forge tests green**
(7 in `Create2Deployer.t.sol`, 5 stateful invariants in `BurnMineInvariant.t.sol`,
each invariant running 64×32 = 2048 calls per the `[invariant]` block). `forge fmt --check`
is clean (it covers the forge-owned `test-forge/` + `script/` only — the shared production
sources are left as authored); `.gas-snapshot` is committed.

## Why we do NOT vendor OpenZeppelin into `lib/`

OZ is resolved from **`node_modules/@openzeppelin/`** (the copy Hardhat already pins at exactly
`5.0.2` in `package.json` + `package-lock.json`), via the `@openzeppelin/=node_modules/@openzeppelin/`
remapping. Pointing forge at the *same* tree guarantees both toolchains compile the **identical**
OZ source — no version drift and no second copy to keep in sync. Only `forge-std` (a forge-only
test dependency with no npm equivalent we use) lives under `lib/`.

## The "J2-skip" decision (no second mock layer for forge)

Foundry's tests need ERC-20/721 fixtures. Rather than vendor or re-import the Hardhat mocks under
`contracts/contracts/mocks/` (which would create a parallel, drifting mock layer and pull Hardhat
test-only contracts into forge's compile set), we keep **small forge-local fixtures** in
`test-forge/helpers/Fixtures.sol` (`FixtureERC20`, `FixtureMintableERC20`, `FixtureERC721`).
They mirror `mocks/MockERC20.sol` / `PoLToken` in spirit but are owned by the forge suite. This is
the deliberately-skipped step: **we did not build a shared cross-toolchain mock package**; each
toolchain keeps its own minimal fixtures. `FixtureMintableERC20` additionally implements
`IMintable` (from `BurnMine.sol`) so it can be passed straight into `BurnMine`'s constructor under
Solidity's static typing — something the dynamically-typed Hardhat tests never had to declare.
