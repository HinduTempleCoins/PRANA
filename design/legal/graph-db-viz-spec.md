# Legal Knowledge Graph — graph DB, visualizations & Hathor query surface (CC2P-3)

_Public design artifact. Consumes the nodes/edges from `lkg-schema.md` and the
treatment edges from `treatment-detection-spec.md`._

## 1. Storage: a property graph (Neo4j-style)

The LKG is a labeled property graph. The reference implementation is **Neo4j**
(Community edition; or an Apache-licensed equivalent — Memgraph, KùzuDB — same
openCypher surface, no lock-in), self-hosted. The graph holds only PD-clean
authorities + the user's taxonomy (see the license-family rule in `lkg-schema.md`).

### Label / relationship mapping

| LKG node `type` | Neo4j label |
|-----------------|-------------|
| Case | `:Case` |
| Statute | `:Statute` |
| CourtRule | `:CourtRule` |
| Maxim | `:Maxim` |
| Category | `:Category` |

| LKG edge `type` | Neo4j relationship |
|-----------------|--------------------|
| cites | `[:CITES]` |
| follows | `[:FOLLOWS {subtype, confidence}]` |
| distinguishes | `[:DISTINGUISHES {confidence}]` |
| overrules | `[:OVERRULES {subtype, confidence}]` |
| interprets | `[:INTERPRETS {confidence}]` |
| applies_statute | `[:APPLIES_STATUTE]` |
| falls_under | `[:FALLS_UNDER]` |
| references | `[:REFERENCES]` |

Treatment relationships keep `confidence`, `subtype`, and the `cue` evidence as
relationship properties so every query can filter by confidence and show the
evidence.

### Indexes / constraints

- Uniqueness constraint on `(:Case|:Statute|:CourtRule|:Maxim|:Category).id`
  (the deterministic id is the dedupe key).
- Index on `Case.year`, `Case.court`, `Category.seedKey`.
- Full-text index on `label` + case body for the **flat search** fallback (so the
  product is usable even before the graph is dense — keyword search over the corpus).

### Two access modes

1. **Graph queries** (Cypher) — relationships, paths, treatment, doctrine timelines.
2. **Flat search** — full-text keyword search over node labels / opinion text, for
   users who just want "find the case about X". The flat index is a plain inverted
   index (the same corpus already lands in the Qdrant W5 collection for semantic
   search; the graph DB's full-text index covers exact keyword).

## 2. The product is the VISUALIZATION

The graph DB is plumbing; the **value is the visual layer** (doc §7). Five views:

### (a) Citation map
An ego-network around one case: inbound `CITES` (who relied on it) and outbound
(what it relied on), edges colored by treatment polarity — green `FOLLOWS`, grey
`DISTINGUISHES`, red `OVERRULES`, blue `INTERPRETS`. Edge opacity = confidence.
Click an edge → the cue quote + link to the opinion paragraph.

```cypher
MATCH (c:Case {id:$caseId})
OPTIONAL MATCH (c)-[out]->(b)
OPTIONAL MATCH (a)-[in]->(c)
RETURN c, out, b, in, a
```

### (b) Doctrine-evolution timeline
Lay the cases under a Category on a time axis; draw treatment edges across time to
show a doctrine being built, narrowed, and (in)validated. A red `OVERRULES` edge
crossing the timeline is the "this line of authority died here" marker.

```cypher
MATCH (cat:Category {id:$categoryId})<-[:FALLS_UNDER]-(c:Case)
OPTIONAL MATCH (c)-[t:OVERRULES|FOLLOWS|DISTINGUISHES]->(b:Case)
RETURN c.label, c.year AS year, type(t) AS treatment, t.confidence, b.label
ORDER BY year
```

### (c) Precedent tree
A DAG rooted at a leading case showing the `FOLLOWS` lineage downstream (the
"children" that adopted it) — the doctrinal family tree.

### (d) "Negative-treatment under a category" report
The headline query: every case in a doctrine that has been overruled/abrogated/
criticized — the "watch out, this might be bad law" list, filterable by founder
category and confidence floor.

```cypher
MATCH (cat:Category {id:$categoryId})<-[:FALLS_UNDER]-(c:Case)
MATCH (c)<-[t:OVERRULES|DISTINGUISHES]-(treating:Case)
WHERE t.confidence >= $minConfidence
RETURN c.label, type(t) AS treatment, t.subtype, t.confidence,
       treating.label AS treatedBy, t.sourceUrl
ORDER BY t.confidence DESC
```

### (e) Statute / rule / maxim view
For a `:Statute`, `:CourtRule`, or `:Maxim`: every case that `INTERPRETS` /
`APPLIES_STATUTE` / `REFERENCES` it — the "how courts have read this" surface.

**Rendering:** a force-directed graph (Cytoscape.js or D3-force) in the SoapBox
front-end, fed by JSON the back-end shapes from Cypher results. Filters: category,
court, year range, treatment type, confidence floor. Every node/edge is clickable
through to the real PD source. The confidence floor slider is front-and-center so
users never see low-confidence inferences as fact.

## 3. Hathor query surface

Hathor (the ecosystem AI witness) gets a **read-only** query surface over the LKG so
it can answer legal-research questions in chat and drop a visualization. Two backing
sources, mediated by an MCP-style tool layer:

- **CourtListener MCP** — live lookups (opinions, citation network, courts) via the
  BB2-1 `tools/adapters/courtlistener.mjs` adapter (read-only, fixture-mode for
  tests). This is how Hathor reaches authorities not yet in the local graph.
- **LKG graph DB** — the local Neo4j-style graph for relationship/treatment/doctrine
  queries that the citation API alone cannot answer.

### Tool surface exposed to Hathor (read-only)

| Tool | Backed by | Returns |
|------|-----------|---------|
| `lkg.findCases({query, category?, court?, yearRange?})` | flat + semantic search | candidate Case nodes |
| `lkg.treatment({caseId, minConfidence})` | graph DB | treatment edges with cue evidence + confidence |
| `lkg.citationMap({caseId})` | graph DB | the (a) citation-map subgraph as JSON |
| `lkg.doctrineTimeline({categoryId})` | graph DB | the (b) timeline series |
| `lkg.negativeUnderCategory({categoryId, minConfidence})` | graph DB | the (d) report |
| `lkg.lookup({citation})` | CourtListener MCP | live authority fetch (for cases not yet ingested) |

### Guardrails baked into the surface

- **Read-only.** No tool mutates the graph; ingestion is a separate offline pipeline
  (CC2P-4).
- **Confidence always returned and always shown.** Hathor must repeat the confidence
  and link the opinion; the system prompt forbids stating treatment as settled fact.
- **Never legal advice.** Hathor presents authorities and inferred relationships as
  research, with the standing disclaimer (this is the same UPL-safe framing as the
  FF2-4 filing app: "information and document service, not a law firm / not legal
  advice").
- **PD-clean only.** The surface can only reach nodes that passed the license-family
  check; it never returns copyrighted commentary.

## 4. Why graph DB (not just the vector store)

The W5 Qdrant collection already gives **semantic similarity** ("cases like this
one"). It cannot answer **relationship** questions: "what overruled X", "the
doctrine timeline under category Y", "the precedent tree below Z". Those are
multi-hop graph traversals. So the two stores are complementary and both are used:
Qdrant for semantic recall (feeds `lkg.findCases`), the property graph for
structure/treatment (feeds everything else).
