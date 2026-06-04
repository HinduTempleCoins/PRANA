// lkg-ingest-skeleton.mjs — Legal Knowledge Graph ingest pipeline (CC2P-4).
//
// A dependency-free, fixture-driven SKELETON of the LKG ingest pipeline. It walks
// the five stages documented in design/legal/lkg-ingest-pipeline.md and emits node
// & edge records in the design/legal -> tools/legal/schemas/lkg-node-edge.schema.json
// shape. No network, no graph DB, no NLP libs — runs under `node --test`.
//
// WHAT IS REAL vs STUBBED (see the spec):
//   - Stage 1 (corpus fetch): STUBBED to read the built-in FIXTURE. Real shape:
//     page the BB2 adapters (courtlistener/govinfo/usc-uslm/ecfr...) in fixture-mode.
//   - Stage 4 (NLP treatment): the cue-matching + confidence math is REAL (CC2P-2);
//     only the sentence splitter is naive. Real shape: swap the splitter/tokenizer +
//     eyecite citation extractor behind detectTreatment().
//   - Stage 5 (graph write): STUBBED to an in-memory idempotent MERGE. Real shape:
//     a Neo4j/Memgraph driver running MERGE per node/edge in a transaction.
//
// CLI: `node tools/legal/lkg-ingest-skeleton.mjs` prints a dry-run over the fixture.

// ---------------------------------------------------------------------------
// Cue lexicon (subset of CC2P-2). Data, not logic — tune without touching code.
// { phrase, treatment, subtype, polarity, weight }
// ---------------------------------------------------------------------------
export const CUE_LEXICON = [
  // NEGATIVE — overrules family
  { phrase: "we overrule", treatment: "overrules", subtype: "overruled", polarity: "negative", weight: 0.97 },
  { phrase: "is overruled", treatment: "overrules", subtype: "overruled", polarity: "negative", weight: 0.97 },
  { phrase: "overruled by", treatment: "overrules", subtype: "overruled", polarity: "negative", weight: 0.95 },
  { phrase: "abrogated by", treatment: "overrules", subtype: "abrogated", polarity: "negative", weight: 0.95 },
  { phrase: "superseded by statute", treatment: "overrules", subtype: "superseded-by-statute", polarity: "negative", weight: 0.95 },
  { phrase: "no longer good law", treatment: "overrules", subtype: "overruled", polarity: "negative", weight: 0.85 },
  // NEGATIVE-soft / limiting
  { phrase: "decline to follow", treatment: "distinguishes", subtype: "limited", polarity: "negative", weight: 0.75 },
  { phrase: "has been criticized", treatment: "distinguishes", subtype: "criticized", polarity: "negative", weight: 0.70 },
  // NEUTRAL — distinguishes
  { phrase: "we distinguish", treatment: "distinguishes", subtype: "distinguished", polarity: "neutral", weight: 0.80 },
  { phrase: "is distinguishable", treatment: "distinguishes", subtype: "distinguished", polarity: "neutral", weight: 0.80 },
  { phrase: "is inapposite", treatment: "distinguishes", subtype: "distinguished", polarity: "neutral", weight: 0.72 },
  // POSITIVE — follows
  { phrase: "we follow", treatment: "follows", subtype: "followed", polarity: "positive", weight: 0.80 },
  { phrase: "we reaffirm", treatment: "follows", subtype: "followed", polarity: "positive", weight: 0.85 },
  { phrase: "we adopt", treatment: "follows", subtype: "adopted", polarity: "positive", weight: 0.78 },
  { phrase: "in accordance with", treatment: "follows", subtype: "followed", polarity: "positive", weight: 0.78 },
  { phrase: "controlled by", treatment: "follows", subtype: "applied", polarity: "positive", weight: 0.80 },
  // NEUTRAL — interprets
  { phrase: "we construe", treatment: "interprets", subtype: "neutral", polarity: "neutral", weight: 0.65 },
];

const TREATMENT_CONFIDENCE_FLOOR = 0.5;

// ---------------------------------------------------------------------------
// Built-in fixture — stands in for the BB2 adapters' output. PD-clean only,
// PLUS one deliberately-copyrighted record to exercise the license gate.
// ---------------------------------------------------------------------------
export const FIXTURE = {
  // Seed taxonomy categories (user-original; structure only, no founder content).
  categories: [
    { seedKey: "free-speech", title: "Free Speech / Sedition", parentKey: null, depth: 0 },
    { seedKey: "free-speech.incitement", title: "Incitement", parentKey: "free-speech", depth: 1 },
  ],
  // Authorities the (stubbed) corpus fetch returns.
  authorities: [
    {
      type: "Case", clKey: "105026", label: "Brandenburg v. Ohio",
      license: "PD", source: "courtlistener",
      sourceUrl: "https://www.courtlistener.com/opinion/105026/brandenburg-v-ohio/",
      citation: "395 U.S. 444", court: "scotus", year: 1969,
      categories: ["free-speech.incitement"],
      // opinion text containing a real overruling cue near a citation
      text: "We overrule Whitney v. California, 274 U.S. 357, whose contrary teaching cannot be supported. We construe the First Amendment to forbid such proscription.",
      citesText: ["274 U.S. 357"],
    },
    {
      type: "Case", clKey: "100001", label: "Whitney v. California",
      license: "PD", source: "courtlistener",
      sourceUrl: "https://www.courtlistener.com/opinion/100001/whitney-v-california/",
      citation: "274 U.S. 357", court: "scotus", year: 1927,
      categories: ["free-speech.incitement"],
      text: "We hold the syndicalism statute valid.",
      citesText: [],
    },
    {
      type: "Statute", uscKey: "usc-18-2385", label: "18 U.S.C. § 2385",
      license: "gov", source: "usc-uslm", corpus: "USC", titleNo: "18", section: "2385",
    },
    // Deliberately copyrighted — MUST be dropped by the license gate.
    {
      type: "Case", clKey: "999999", label: "Copyrighted Treatise Excerpt",
      license: "copyrighted-3p", source: "thirdparty",
      sourceUrl: "https://example.com/treatise", text: "", citesText: [],
    },
  ],
  // Structural citation graph (as CourtListener would return): citingClKey -> citedKey
  citationGraph: [
    { fromClKey: "105026", toKey: "100001", toCitation: "274 U.S. 357" },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const PD_CLEAN = new Set(["PD", "gov", "user-original"]);

function authorityNodeId(a) {
  if (a.type === "Case") return `case:cl-${a.clKey}`;
  if (a.type === "Statute") return `statute:${a.uscKey}`;
  if (a.type === "CourtRule") return `courtrule:${a.ruleKey}`;
  if (a.type === "Maxim") return `maxim:${a.maximKey}`;
  throw new Error(`unknown authority type: ${a.type}`);
}
const categoryNodeId = (seedKey) => `category:${seedKey}`;

// ---------------------------------------------------------------------------
// STAGE 0 — seed taxonomy -> Category nodes
// ---------------------------------------------------------------------------
export function seedToCategoryNodes(categories) {
  return categories.map((c) => ({
    kind: "node",
    id: categoryNodeId(c.seedKey),
    type: "Category",
    label: c.title,
    licenseFamily: "user-original",
    source: "taxonomy-seed",
    category: {
      ...(c.parentKey ? { parentId: categoryNodeId(c.parentKey) } : {}),
      depth: c.depth,
      seedKey: c.seedKey,
    },
  }));
}

// ---------------------------------------------------------------------------
// STAGE 1 — corpus fetch (STUBBED: returns the fixture authorities) + toNodes
// Real shape: page the BB2 adapters in fixture-mode and normalize.
// ---------------------------------------------------------------------------
export function fetchCorpus(fixture = FIXTURE) {
  return fixture.authorities.slice();
}

export function toNodes(authorities) {
  return authorities.map((a) => {
    const node = {
      kind: "node",
      id: authorityNodeId(a),
      type: a.type,
      label: a.label,
      licenseFamily: a.license,
      source: a.source,
      ...(a.sourceUrl ? { sourceUrl: a.sourceUrl } : {}),
    };
    if (a.type === "Case") {
      node.case = { citation: a.citation, court: a.court, year: a.year };
    } else if (a.type === "Statute") {
      node.statute = { title: a.titleNo, section: a.section, corpus: a.corpus };
    }
    return node;
  });
}

// ---------------------------------------------------------------------------
// STAGE 2 — license gate (AA2-4): keep only PD-clean nodes.
// ---------------------------------------------------------------------------
export function licenseGate(nodes) {
  const kept = [];
  const dropped = [];
  for (const n of nodes) {
    if (PD_CLEAN.has(n.licenseFamily)) kept.push(n);
    else dropped.push(n);
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// STAGE 3 — structural cites edges + falls_under category edges.
// ---------------------------------------------------------------------------
export function structuralEdges(citationGraph) {
  return citationGraph.map((c) => {
    const from = `case:cl-${c.fromClKey}`;
    const to = `case:cl-${c.toKey}`;
    return {
      kind: "edge",
      id: `cites:${from}->${to}`,
      type: "cites",
      from,
      to,
      confidence: 1,
    };
  });
}

export function categoryEdges(authorities) {
  const edges = [];
  for (const a of authorities) {
    if (!a.categories || a.license === "copyrighted-3p") continue;
    const from = authorityNodeId(a);
    for (const seedKey of a.categories) {
      const to = categoryNodeId(seedKey);
      edges.push({
        kind: "edge",
        id: `falls_under:${from}->${to}`,
        type: "falls_under",
        from,
        to,
      });
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// STAGE 4 — NLP treatment detection (CC2P-2). The cue match + confidence math is
// REAL; the sentence splitter is naive (the documented replaceable part).
// ---------------------------------------------------------------------------
// Common legal abbreviations whose trailing "." must NOT end a sentence. The
// production NLP layer uses a trained sentence splitter; here we protect the
// abbreviations that otherwise shred citations ("v.", "U.S.", "F.2d", ...).
const ABBREVIATIONS = ["v", "U.S", "F.2d", "F.3d", "F", "Cir", "Co", "Inc", "No", "Ed", "S.Ct", "L.Ed"];

function splitSentences(text) {
  // Split on sentence terminators followed by whitespace + a capital letter,
  // but never right after a known legal abbreviation. Offsets are preserved.
  const out = [];
  let start = 0;
  const re = /([.;!?])\s+(?=[A-Z0-9])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const head = text.slice(start, m.index);
    const lastTok = (head.match(/(\S+)$/) || ["", ""])[1].replace(/[.,]$/, "");
    if (ABBREVIATIONS.includes(lastTok)) continue; // not a real boundary
    out.push({ text: text.slice(start, m.index + 1), offset: start });
    start = m.index + m[0].length;
  }
  if (start < text.length) out.push({ text: text.slice(start), offset: start });
  return out;
}

// Negation is scoped to a small window IMMEDIATELY BEFORE the cue phrase (the
// standard NLP scope: negation attaches to the governed verb, e.g. "we do not
// follow"). A "cannot" elsewhere in the sentence (part of the reasoning) does NOT
// flip the cue. The production NLP layer uses a dependency-parse negation scope.
function cueIsNegated(text, cueIdx) {
  const window = text.slice(Math.max(0, cueIdx - 24), cueIdx);
  return /\b(do not|does not|did not|not|cannot|never|decline to|refuse to)\s*$/i.test(window);
}

/**
 * detectTreatment(opinionText, citations) -> [{treatment, subtype, polarity,
 * confidence, cue}]. `citations` is [{citation, citedNodeId}] resolved upstream.
 * Real impl swaps splitSentences/tokenizer + eyecite citation extractor.
 */
export function detectTreatment(opinionText, citations) {
  if (!opinionText || !Array.isArray(citations) || citations.length === 0) return [];
  const sentences = splitSentences(opinionText);
  const results = [];

  for (const cit of citations) {
    const citIdx = opinionText.indexOf(cit.citation);
    if (citIdx < 0) continue;

    // find the cue with the strongest signal within proximity of the citation
    let best = null;
    for (const cue of CUE_LEXICON) {
      const cueIdx = opinionText.toLowerCase().indexOf(cue.phrase);
      if (cueIdx < 0) continue;

      // sentence distance between cue and citation
      const cueSentence = sentences.findIndex(
        (s) => cueIdx >= s.offset && cueIdx < s.offset + s.text.length
      );
      const citSentence = sentences.findIndex(
        (s) => citIdx >= s.offset && citIdx < s.offset + s.text.length
      );
      const dist = cueSentence < 0 || citSentence < 0 ? 3 : Math.abs(cueSentence - citSentence);
      const proximity = 1 / (1 + dist);

      const negFlip = cueIsNegated(opinionText, cueIdx) && cue.polarity !== "neutral" ? 0.4 : 1.0;

      const confidence = Math.max(0, Math.min(1, cue.weight * proximity * negFlip));
      if (!best || confidence > best.confidence) {
        best = {
          treatment: cue.treatment,
          subtype: cue.subtype,
          polarity: cue.polarity,
          confidence: Number(confidence.toFixed(4)),
          citedNodeId: cit.citedNodeId,
          cue: {
            phrase: cue.phrase,
            quote: (sentences[cueSentence]?.text ?? "").trim(),
            offset: cueIdx,
            polarity: cue.polarity,
          },
        };
      }
    }
    if (best && best.confidence >= TREATMENT_CONFIDENCE_FLOOR) results.push(best);
  }
  return results;
}

export function treatmentEdges(authorities, citationGraph) {
  const edges = [];
  // build a citation-resolution map per citing case
  for (const a of authorities) {
    if (a.type !== "Case" || a.license === "copyrighted-3p" || !a.text) continue;
    const cites = citationGraph
      .filter((c) => c.fromClKey === a.clKey)
      .map((c) => ({ citation: c.toCitation, citedNodeId: `case:cl-${c.toKey}` }));
    const detected = detectTreatment(a.text, cites);
    const from = authorityNodeId(a);
    for (const d of detected) {
      edges.push({
        kind: "edge",
        id: `${d.treatment}:${from}->${d.citedNodeId}`,
        type: d.treatment,
        from,
        to: d.citedNodeId,
        subtype: d.subtype,
        confidence: d.confidence,
        cue: d.cue,
        ...(a.sourceUrl ? { sourceUrl: a.sourceUrl } : {}),
      });
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// STAGE 5 — graph write (STUBBED: in-memory idempotent MERGE).
// Real shape: Neo4j/Memgraph driver, MERGE (n {id}) / MERGE (a)-[:REL]->(b).
// ---------------------------------------------------------------------------
export function writeGraph(nodes, edges, store = { nodes: new Map(), edges: new Map() }) {
  for (const n of nodes) store.nodes.set(n.id, n); // MERGE on id
  for (const e of edges) store.edges.set(e.id, e); // MERGE on id
  return {
    store,
    nodesWritten: nodes.length,
    edgesWritten: edges.length,
    nodeCount: store.nodes.size,
    edgeCount: store.edges.size,
  };
}

// ---------------------------------------------------------------------------
// Orchestration — runDryRun walks all five stages over a fixture.
// ---------------------------------------------------------------------------
export function runDryRun(fixture = FIXTURE) {
  // Stage 0
  const categoryNodes = seedToCategoryNodes(fixture.categories);
  // Stage 1
  const authorities = fetchCorpus(fixture);
  const authorityNodes = toNodes(authorities);
  // Stage 2
  const allNodes = [...categoryNodes, ...authorityNodes];
  const { kept, dropped } = licenseGate(allNodes);
  // Stage 3
  const cites = structuralEdges(fixture.citationGraph);
  const falls = categoryEdges(authorities);
  // Stage 4
  const treatments = treatmentEdges(authorities, fixture.citationGraph);
  const edges = [...cites, ...falls, ...treatments];
  // Stage 5
  const write = writeGraph(kept, edges);

  return {
    nodes: kept,
    edges,
    stats: {
      categoryNodes: categoryNodes.length,
      authorityNodes: authorityNodes.length,
      keptNodes: kept.length,
      droppedNonPd: dropped.length,
      citesEdges: cites.length,
      fallsUnderEdges: falls.length,
      treatmentEdges: treatments.length,
      nodesWritten: write.nodesWritten,
      edgesWritten: write.edgesWritten,
    },
  };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runDryRun();
  console.log("LKG ingest dry-run (fixture)\n");
  console.log("stats:", JSON.stringify(result.stats, null, 2));
  console.log("\nnodes:");
  for (const n of result.nodes) console.log(`  ${n.type.padEnd(9)} ${n.id}  [${n.licenseFamily}]  ${n.label}`);
  console.log("\nedges:");
  for (const e of result.edges) {
    const conf = e.confidence !== undefined ? ` conf=${e.confidence}` : "";
    const sub = e.subtype ? `/${e.subtype}` : "";
    console.log(`  ${e.type}${sub} ${e.from} -> ${e.to}${conf}`);
  }
}

export default { runDryRun, CUE_LEXICON };
