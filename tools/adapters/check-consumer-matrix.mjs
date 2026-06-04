#!/usr/bin/env node
// W10 — consumer-matrix lint.
//
// Ensures every data adapter in tools/adapters/ is actually wired to a
// consuming component, and that consumers.json doesn't reference adapters that
// don't exist. Exits 1 on any mismatch so it can gate CI.
//
// "adapter" = a *.mjs file in this directory tree that (a) is not a *.test.mjs
// and (b) has at least one top-level `export`. (base.mjs counts — it's the
// shared layer and must also be claimed by a consumer so nothing is orphaned.)
//
// The scan recurses one level into topic subdirectories (legal/, library/,
// media/, …). Top-level adapters are keyed by their bare filename
// ("subgraph.mjs"); nested adapters are keyed by their POSIX path relative to
// this directory ("legal/courtlistener.mjs"). consumers.json must use the same
// keys.
//
// Usage:
//   node check-consumer-matrix.mjs                 (default: adapter-matrix lint)
//   node check-consumer-matrix.mjs --catalog <p>   (optional: catalog coverage REPORT)
//
// The optional `--catalog <path>` mode is a *report*, not a gate: given a
// resource-catalog JSON ({ tools: [{ name, ... }] }), it lists which catalog
// entries have NO consumer mapping yet. It NEVER changes the exit code and is
// fully independent of the default adapter lint above (existing tests untouched).

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONSUMERS_FILE = path.join(DIR, "consumers.json");

const EXPORT_RE = /^\s*export\s+(?:default|const|function|class|async|let|var|\{|\*)/m;

// Collect adapter keys from a directory. `rel` is the POSIX prefix for nested
// dirs ("" at top level). Recurses exactly one level deep into subdirectories.
async function collectAdapters(dir, rel, depth, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (depth <= 0) continue; // recurse one level only
      if (ent.name === "fixtures" || ent.name === "node_modules") continue;
      await collectAdapters(
        path.join(dir, ent.name),
        rel ? `${rel}/${ent.name}` : ent.name,
        depth - 1,
        out
      );
      continue;
    }
    const name = ent.name;
    if (!name.endsWith(".mjs")) continue;
    if (name.endsWith(".test.mjs")) continue;
    if (rel === "" && name === "check-consumer-matrix.mjs") continue; // the linter itself
    const src = await readFile(path.join(dir, name), "utf8");
    if (EXPORT_RE.test(src)) out.push(rel ? `${rel}/${name}` : name);
  }
}

async function listAdapters() {
  const adapters = [];
  await collectAdapters(DIR, "", 1, adapters);
  return adapters.sort();
}

async function loadConsumers() {
  let raw;
  try {
    raw = await readFile(CONSUMERS_FILE, "utf8");
  } catch (err) {
    throw new Error(`cannot read consumers.json: ${err.message}`);
  }
  const json = JSON.parse(raw);
  const map = json.consumers ?? {};
  if (typeof map !== "object" || Array.isArray(map)) {
    throw new Error("consumers.json: `consumers` must be an object");
  }
  return map;
}

export async function checkConsumerMatrix() {
  const adapters = await listAdapters();
  const consumers = await loadConsumers();

  const consumerKeys = Object.keys(consumers);
  const adapterSet = new Set(adapters);

  const orphanAdapters = adapters.filter(
    (a) => !consumers[a] || String(consumers[a]).trim() === ""
  );
  const danglingConsumers = consumerKeys.filter((k) => !adapterSet.has(k));

  return { adapters, consumers, orphanAdapters, danglingConsumers };
}

// --- Optional catalog-coverage report (JJ2 second mode) ----------------------
// Reports (does NOT fail) which JJ1-catalog entries lack a consumer mapping.
// "consumer mapping" = the entry's `name` (or the lowercased, hyphenated form
// of it) appears as a consumer role value OR is name-matched in consumers.json.
// Heuristic + advisory by design: the catalog is a broad resource map, so most
// entries are expected to be unmapped; this just surfaces the gap.
export async function reportCatalogCoverage(catalogPath) {
  const consumers = await loadConsumers();
  const mappedRoles = new Set(Object.values(consumers).map((v) => String(v).toLowerCase()));
  const mappedAdapters = new Set(Object.keys(consumers).map((k) => k.toLowerCase()));

  let doc;
  try {
    doc = JSON.parse(await readFile(catalogPath, "utf8"));
  } catch (err) {
    throw new Error(`cannot read catalog ${catalogPath}: ${err.message}`);
  }
  const tools = Array.isArray(doc.tools) ? doc.tools : [];

  const mapped = [];
  const unmapped = [];
  for (const tool of tools) {
    const name = String(tool?.name ?? "").trim();
    if (!name) continue;
    const slug = name.toLowerCase();
    const hyphen = slug.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const hit =
      mappedRoles.has(slug) ||
      mappedRoles.has(hyphen) ||
      mappedAdapters.has(`${hyphen}.mjs`) ||
      [...mappedRoles].some((r) => r.includes(hyphen) || hyphen.includes(r));
    (hit ? mapped : unmapped).push(name);
  }
  return { total: tools.length, mapped, unmapped };
}

async function mainCatalog(catalogPath) {
  let report;
  try {
    report = await reportCatalogCoverage(catalogPath);
  } catch (err) {
    console.error(`consumer-matrix(catalog): ${err.message}`);
    process.exit(1); // a bad/missing catalog path is a usage error, not a coverage finding
  }
  const { total, mapped, unmapped } = report;
  console.log(
    `consumer-matrix(catalog): ${total} catalog entr${total === 1 ? "y" : "ies"} scanned; ` +
      `${mapped.length} with a consumer mapping, ${unmapped.length} without.`
  );
  if (mapped.length) {
    console.log(`consumer-matrix(catalog): mapped -> ${mapped.join(", ")}`);
  }
  console.log(
    "consumer-matrix(catalog): the following catalog entries have NO consumer mapping yet (advisory, not a failure):"
  );
  for (const name of unmapped) console.log(`  - ${name}`);
  // Advisory mode: always succeed.
  process.exit(0);
}

async function main() {
  let result;
  try {
    result = await checkConsumerMatrix();
  } catch (err) {
    console.error(`consumer-matrix: ${err.message}`);
    process.exit(1);
  }

  const { adapters, orphanAdapters, danglingConsumers } = result;
  console.log(`consumer-matrix: scanned ${adapters.length} adapter(s): ${adapters.join(", ")}`);

  let ok = true;
  if (orphanAdapters.length) {
    ok = false;
    console.error(
      `consumer-matrix: FAIL — adapter(s) with no consumer in consumers.json: ${orphanAdapters.join(", ")}`
    );
  }
  if (danglingConsumers.length) {
    ok = false;
    console.error(
      `consumer-matrix: FAIL — consumers.json references missing adapter(s): ${danglingConsumers.join(", ")}`
    );
  }

  if (ok) {
    console.log("consumer-matrix: OK — every adapter has a consumer and vice versa.");
    process.exit(0);
  }
  process.exit(1);
}

// Only run when executed directly, not when imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catalogIdx = process.argv.indexOf("--catalog");
  if (catalogIdx !== -1) {
    const catalogPath = process.argv[catalogIdx + 1];
    if (!catalogPath) {
      console.error("consumer-matrix: --catalog requires a path argument");
      process.exit(1);
    }
    mainCatalog(catalogPath);
  } else {
    main(); // default adapter-matrix lint — unchanged
  }
}
