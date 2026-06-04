# CREATE2 salt registry — PRANA

`contracts/contracts/Create2Deployer.sol` deploys via `CREATE2`, so a contract's address is a
pure function of `(deployer, salt, keccak256(creationCode))` and is independent of nonce. That
determinism is the whole point (cross-chain / bridge wiring, address pre-commitment, idempotent
redeploys) — but it also means **two deployments that reuse the same `(salt, creationCode)` collide**:
the second `deploy()` reverts with `AlreadyDeployed(addr)`.

To keep that coordinated, every salt that is meant to be *stable across environments* is recorded
here. Salts used only inside a single test are local to that test and need not be listed.

## How salts are derived

- Human-readable salts: `keccak256("prana.<domain>.<name>.v<N>")` — namespaced + versioned so a
  recompiled contract (new creation code) can take a fresh `v<N+1>` slot instead of colliding.
- Opaque/numeric salts (`bytes32(uint256(...))`) are fine for throwaway test fixtures.

## Registry

| Salt (preimage)            | Computed from              | Used by                                   | Notes |
|----------------------------|----------------------------|-------------------------------------------|-------|
| `prana.fixture.v1`         | `keccak256("prana.fixture.v1")` | `Create2Deployer.t.sol` (predicted==actual) | Example/test only. |
| `prana.<contract>.v1`      | `keccak256(...)`           | (reserve here when a real deploy is added) | Bump `v` on creation-code change. |

> When you add a production deployment (token engine, AMM factory, burn mine, bridge
> endpoint), append a row here BEFORE running `forge script`. Picking a salt already in this
> table for different creation code will revert on-chain; picking the same `(salt, code)` is an
> idempotent no-op that reverts as `AlreadyDeployed` — intended.
