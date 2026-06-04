# Legal Knowledge Graph — ingest pipeline (CC2P-4)

_Public design artifact. Runnable skeleton: `tools/legal/lkg-ingest-skeleton.mjs`
(+ `tools/legal/lkg-ingest-skeleton.test.mjs`). Emits records in the
`tools/legal/schemas/lkg-node-edge.schema.json` shape._

## Overview

The pipeline turns the user's **seed taxonomy** + the **public-domain legal corpus**
into the LKG (graph DB) that the visualizations (CC2P-3) read.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ STAGE 0  taxonomy seed   (user data; private)                              │
│   tools/brain/state/design/legal/taxonomy-seed.schema.json shape           │
│   → Category nodes (licenseFamily: user-original)                          │
├──────────────────────────────────────────────────────────────────────────┤
│ STAGE 1  corpus fetch    (BB2 legal adapters, read-only, PD)               │
│   courtlistener / caselaw-access-project / govinfo / usc-uslm / ecfr       │
│   → Case · Statute · CourtRule · Maxim nodes (licenseFamily: PD | gov)     │
├──────────────────────────────────────────────────────────────────────────┤
│ STAGE 2  license check   (AA2-4 license-router)                            │
│   assert every node is PD-clean (PD | gov | user-original); drop the rest  │
├──────────────────────────────────────────────────────────────────────────┤
│ STAGE 3  structural edges (CourtListener citation graph)                   │
│   → cites edges (confidence 1.0)                                           │
│   + falls_under edges (Case/Statute → Category) from taxonomy mapping      │
├──────────────────────────────────────────────────────────────────────────┤
│ STAGE 4  treatment edges  (NLP cue detection; CC2P-2)                      │
│   detectTreatment(opinionText, citations)                                  │
│   → follows / distinguishes / overrules / interprets (confidence-scored)   │
├──────────────────────────────────────────────────────────────────────────┤
│ STAGE 5  graph write      (Neo4j-style upsert; CC2P-3)                     │
│   MERGE nodes on id, MERGE edges on id — idempotent                        │
└──────────────────────────────────────────────────────────────────────────┘
```

## Stage interfaces

Each stage is a pure-ish function with a documented signature so stages can be
tested in isolation and the heavy real implementations dropped in behind the same
contract.

| Stage | Function | In → Out |
|-------|----------|----------|
| 0 | `seedToCategoryNodes(seed)` | taxonomy seed object → `Category` node records |
| 1 | `fetchCorpus(plan, adapters)` | fetch plan + BB2 adapters → raw authority records |
| 1b | `toNodes(rawRecords)` | raw authority records → `Case`/`Statute`/`CourtRule`/`Maxim` node records |
| 2 | `licenseGate(nodes)` | nodes → only PD-clean nodes (drops + logs the rest) |
| 3 | `structuralEdges(citationGraph)` | CL citation graph → `cites` edges |
| 3b | `categoryEdges(nodes, mapping)` | nodes + taxonomy mapping → `falls_under` edges |
| 4 | `treatmentEdges(opinions)` | opinion texts + their citations → treatment edges |
| 5 | `writeGraph(nodes, edges, driver)` | records → idempotent MERGE into the graph DB |

## Real vs stubbed

The skeleton (`lkg-ingest-skeleton.mjs`) is **fixture-driven and dependency-free**
so it runs under `node --test` with no network, no DB, no NLP libs:

- **Stage 1 (corpus fetch)** is stubbed to read a small in-file fixture instead of
  calling the BB2 adapters. *Real shape:* `import courtlistener from
  "../adapters/courtlistener.mjs"` and page the opinions/clusters endpoints in
  fixture-mode, exactly like the W-group adapters.
- **Stage 4 (NLP treatment)** runs the **real** cue-matching logic from CC2P-2
  against a small built-in lexicon over the fixture opinion text — so the confidence
  scoring is genuinely exercised — but uses a naive sentence splitter. *Real shape:*
  swap the splitter/tokenizer for a proper NLP layer + the eyecite citation
  extractor behind the same `detectTreatment` signature.
- **Stage 5 (graph write)** is stubbed to an in-memory `MERGE` (a Map keyed by id)
  that returns the same `{nodesWritten, edgesWritten}` envelope a Neo4j driver would.
  *Real shape:* a Neo4j/Memgraph driver running `MERGE (n:Label {id})` /
  `MERGE (a)-[:REL {…}]->(b)` in a single transaction per batch.

A `runDryRun(fixture)` entry point walks all five stages end-to-end over the fixture
and returns the assembled `{nodes, edges, stats}` — this is what the test asserts on,
and what you can run from the CLI to see the pipeline shape.

## Idempotency & dedupe

- Node ids and edge ids are deterministic (`lkg-schema.md`), so re-running the
  pipeline `MERGE`s rather than duplicates.
- Stage 2 is a hard gate: a node that is not `PD | gov | user-original` is dropped
  and counted in `stats.droppedNonPd` — the LKG never ingests copyrighted text.
- Treatment edges below the confidence floor (default 0.50) are not emitted; the
  underlying `cites` edge remains.

## Running

```
node tools/legal/lkg-ingest-skeleton.mjs        # prints a dry-run over the built-in fixture
node --test tools/legal/lkg-ingest-skeleton.test.mjs
```

No hardhat, no network, no DB. The real pipeline wires the same stage functions to
the BB2 adapters, an NLP layer, and a graph driver.
