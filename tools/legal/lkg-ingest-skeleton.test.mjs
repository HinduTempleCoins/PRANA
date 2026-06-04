// lkg-ingest-skeleton.test.mjs — offline tests for the LKG ingest pipeline (CC2P-4).
// No network, no DB, no NLP deps. `node --test tools/legal/lkg-ingest-skeleton.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FIXTURE,
  seedToCategoryNodes,
  toNodes,
  licenseGate,
  structuralEdges,
  categoryEdges,
  detectTreatment,
  treatmentEdges,
  writeGraph,
  runDryRun,
  CUE_LEXICON,
} from "./lkg-ingest-skeleton.mjs";

test("seedToCategoryNodes builds user-original Category nodes with parent links", () => {
  const nodes = seedToCategoryNodes(FIXTURE.categories);
  assert.equal(nodes.length, 2);
  const root = nodes.find((n) => n.id === "category:free-speech");
  const child = nodes.find((n) => n.id === "category:free-speech.incitement");
  assert.equal(root.type, "Category");
  assert.equal(root.licenseFamily, "user-original");
  assert.equal(root.category.parentId, undefined); // root has no parent
  assert.equal(child.category.parentId, "category:free-speech");
  assert.equal(child.category.depth, 1);
});

test("toNodes maps authorities to typed node records", () => {
  const nodes = toNodes(FIXTURE.authorities);
  const brandenburg = nodes.find((n) => n.id === "case:cl-105026");
  assert.equal(brandenburg.type, "Case");
  assert.equal(brandenburg.case.citation, "395 U.S. 444");
  const statute = nodes.find((n) => n.id === "statute:usc-18-2385");
  assert.equal(statute.type, "Statute");
  assert.equal(statute.licenseFamily, "gov");
});

test("licenseGate drops copyrighted-3p and keeps PD-clean", () => {
  const nodes = toNodes(FIXTURE.authorities);
  const { kept, dropped } = licenseGate(nodes);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].id, "case:cl-999999");
  assert.ok(kept.every((n) => ["PD", "gov", "user-original"].includes(n.licenseFamily)));
});

test("structuralEdges emits confidence-1.0 cites edges", () => {
  const edges = structuralEdges(FIXTURE.citationGraph);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].type, "cites");
  assert.equal(edges[0].confidence, 1);
  assert.equal(edges[0].from, "case:cl-105026");
  assert.equal(edges[0].to, "case:cl-100001");
});

test("categoryEdges links authorities to their seed categories, skips copyrighted", () => {
  const edges = categoryEdges(FIXTURE.authorities);
  assert.ok(edges.some((e) => e.id === "falls_under:case:cl-105026->category:free-speech.incitement"));
  // copyrighted case 999999 has no categories and is skipped
  assert.ok(!edges.some((e) => e.from === "case:cl-999999"));
});

test("detectTreatment finds the overruling cue and scores high confidence", () => {
  const cites = [{ citation: "274 U.S. 357", citedNodeId: "case:cl-100001" }];
  const brandenburg = FIXTURE.authorities.find((a) => a.clKey === "105026");
  const detected = detectTreatment(brandenburg.text, cites);
  assert.equal(detected.length, 1);
  const t = detected[0];
  assert.equal(t.treatment, "overrules");
  assert.equal(t.subtype, "overruled");
  assert.equal(t.polarity, "negative");
  assert.ok(t.confidence >= 0.85, `expected high confidence, got ${t.confidence}`);
  assert.ok(t.cue.phrase.length > 0);
  assert.ok(/overrul/i.test(t.cue.quote));
});

test("detectTreatment returns nothing below the confidence floor / no cue", () => {
  const cites = [{ citation: "274 U.S. 357", citedNodeId: "case:cl-100001" }];
  assert.deepEqual(detectTreatment("A neutral sentence that cites 274 U.S. 357 plainly.", cites), []);
  assert.deepEqual(detectTreatment("", cites), []);
  assert.deepEqual(detectTreatment("text", []), []);
});

test("treatmentEdges emits typed treatment edges with cue evidence", () => {
  const edges = treatmentEdges(FIXTURE.authorities, FIXTURE.citationGraph);
  assert.equal(edges.length, 1);
  const e = edges[0];
  assert.equal(e.type, "overrules");
  assert.equal(e.id, "overrules:case:cl-105026->case:cl-100001");
  assert.ok(e.cue && e.cue.phrase);
  assert.ok(e.sourceUrl); // treatment edge must be traceable
});

test("writeGraph is idempotent (MERGE on id)", () => {
  const { store, ...first } = writeGraph(
    [{ id: "n1" }, { id: "n2" }],
    [{ id: "e1" }]
  );
  assert.equal(first.nodeCount, 2);
  assert.equal(first.edgeCount, 1);
  // re-write the same ids -> no growth
  const second = writeGraph([{ id: "n1" }], [{ id: "e1" }], store);
  assert.equal(second.nodeCount, 2);
  assert.equal(second.edgeCount, 1);
});

test("runDryRun walks all five stages end-to-end over the fixture", () => {
  const { nodes, edges, stats } = runDryRun();
  // 2 categories + 3 PD-clean authorities (Brandenburg, Whitney, statute) = 5 kept; 1 dropped
  assert.equal(stats.droppedNonPd, 1);
  assert.equal(stats.keptNodes, 5);
  assert.equal(stats.citesEdges, 1);
  assert.ok(stats.treatmentEdges >= 1);
  assert.ok(stats.fallsUnderEdges >= 2);
  // every kept node is PD-clean
  assert.ok(nodes.every((n) => ["PD", "gov", "user-original"].includes(n.licenseFamily)));
  // no edge points at the dropped copyrighted node
  assert.ok(edges.every((e) => e.from !== "case:cl-999999" && e.to !== "case:cl-999999"));
});

test("CUE_LEXICON entries are well-formed", () => {
  for (const c of CUE_LEXICON) {
    assert.ok(typeof c.phrase === "string" && c.phrase.length > 0);
    assert.ok(["overrules", "follows", "distinguishes", "interprets"].includes(c.treatment));
    assert.ok(["positive", "negative", "neutral"].includes(c.polarity));
    assert.ok(c.weight > 0 && c.weight <= 1);
  }
});
