# PRANA subgraph skeleton

A **schema + manifest only** scaffold for indexing PRANA's AMM pools and ERC-20
transfers with [The Graph](https://thegraph.com/) running on a **self-hosted
graph-node** (no hosted-service / decentralized network needed for a private
chain).

This directory intentionally ships **no mapping handlers and no deploy step** —
it documents the entity model (`schema.graphql`) and the event wiring
(`subgraph.yaml`) so the indexer can be assembled later.

## What it indexes

- **V2-style Pair** events: `Swap`, `Mint`, `Burn`, `Sync` → `Pair`, `Swap`,
  `Mint`, `Burn`, `Sync` entities (event signatures match
  `contracts/contracts/amm/interfaces/IUniswapV2Pair.sol`).
- **ERC-20** `Transfer` → `Token`, `Transfer` entities.

## Files

| file             | role                                                        |
|------------------|-------------------------------------------------------------|
| `schema.graphql` | GraphQL entity definitions queried by the adapter.          |
| `subgraph.yaml`  | Manifest: which contracts/events map to which handlers.     |
| `src/*.ts`       | (NOT included) AssemblyScript mapping handlers.             |
| `abis/*.json`    | (NOT included) copy `UniswapV2Pair.json` / `ERC20.json` from `contracts/abis`. |

## How it would be deployed later (self-hosted graph-node)

> Not done here — reference only.

1. **Run the stack** (graph-node + IPFS + Postgres) via Docker Compose, with
   graph-node's `ethereum` env pointed at the PRANA RPC, e.g.
   `ethereum: "prana:http://host.docker.internal:8545"` (the alias `prana`
   matches `network:` in `subgraph.yaml`).
2. **Fill placeholders** in `subgraph.yaml`: the deployed Pair / ERC-20
   `address` and `startBlock` (the block each contract was created in).
3. **Add mappings**: write `src/pair.ts` and `src/token.ts` AssemblyScript
   handlers (`handleSwap`, `handleMint`, `handleBurn`, `handleSync`,
   `handleTransfer`) that build the entities from event params, and copy the
   ABIs into `abis/`.
4. **Codegen + build** with the Graph CLI (`graph codegen` then `graph build`).
   These tools require an `npm install` and are therefore **out of scope** for
   this repo's no-install constraint.
5. **Create + deploy** to the local node:
   `graph create --node http://localhost:8020 prana/amm`
   then `graph deploy --node http://localhost:8020 --ipfs http://localhost:5001 prana/amm`.
6. The node then serves a GraphQL endpoint (default
   `http://localhost:8000/subgraphs/name/prana/amm`) — point `subgraph.mjs`'s
   `query(endpoint, ...)` at that URL.

## Querying via the adapter

Once deployed, the sibling `../subgraph.mjs` adapter queries it with plain
`fetch`:

```js
import { query } from "../subgraph.mjs";
const data = await query(
  "http://localhost:8000/subgraphs/name/prana/amm",
  `query Recent($n: Int!) {
     swaps(first: $n, orderBy: timestamp, orderDirection: desc) {
       id amount0In amount1Out pair { id }
     }
   }`,
  { n: 10 }
);
```
