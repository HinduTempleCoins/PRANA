// W5 — qdrant.mjs tests. Fixture/injected-fetch based, no live Qdrant.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCreateCollectionBody,
  buildUpsertBody,
  buildSearchBody,
  parseSearchResult,
  ensureCollection,
  upsertPoints,
  search,
} from "./qdrant.mjs";

test("buildCreateCollectionBody shapes vectors config", () => {
  assert.deepEqual(buildCreateCollectionBody(768, "Cosine"), {
    vectors: { size: 768, distance: "Cosine" },
  });
});

test("buildCreateCollectionBody rejects bad size/distance", () => {
  assert.throws(() => buildCreateCollectionBody(0), /positive integer/);
  assert.throws(() => buildCreateCollectionBody(8, "Nope"), /distance must be/);
});

test("buildUpsertBody normalizes points and keeps payload", () => {
  const body = buildUpsertBody([
    { id: 1, vector: [0.1, 0.2], payload: { title: "t" } },
    { id: "uuid-2", vector: [0.3, 0.4] },
  ]);
  assert.equal(body.points.length, 2);
  assert.deepEqual(body.points[0], { id: 1, vector: [0.1, 0.2], payload: { title: "t" } });
  assert.equal("payload" in body.points[1], false);
});

test("buildUpsertBody rejects missing id/vector", () => {
  assert.throws(() => buildUpsertBody([]), /non-empty array/);
  assert.throws(() => buildUpsertBody([{ vector: [1] }]), /missing id/);
  assert.throws(() => buildUpsertBody([{ id: 1 }]), /numeric vector/);
});

test("buildSearchBody sets limit, payload, threshold, filter", () => {
  const b = buildSearchBody([0.1, 0.2], {
    limit: 3,
    withPayload: true,
    scoreThreshold: 0.7,
    filter: { must: [] },
  });
  assert.deepEqual(b, {
    vector: [0.1, 0.2],
    limit: 3,
    with_payload: true,
    score_threshold: 0.7,
    filter: { must: [] },
  });
});

test("parseSearchResult normalizes Qdrant envelope", () => {
  const fixture = {
    result: [
      { id: 7, score: 0.91, payload: { title: "a" } },
      { id: 9, score: 0.42 },
    ],
  };
  assert.deepEqual(parseSearchResult(fixture), [
    { id: 7, score: 0.91, payload: { title: "a" } },
    { id: 9, score: 0.42, payload: null },
  ]);
});

test("parseSearchResult throws on missing result array", () => {
  assert.throws(() => parseSearchResult({}), /missing `result`/);
});

test("ensureCollection PUTs and treats 409 as exists (injected fetch)", async () => {
  let called = 0;
  const fetchImpl = async (url, opts) => {
    called++;
    assert.equal(opts.method, "PUT");
    assert.match(url, /\/collections\/papers$/);
    return { ok: false, status: 409, text: async () => JSON.stringify({ status: { error: "exists" } }) };
  };
  const r = await ensureCollection("papers", 768, "Cosine", { fetchImpl });
  assert.equal(called, 1);
  assert.equal(r.status, "exists");
});

test("upsertPoints sends body to points endpoint (injected fetch)", async () => {
  const fetchImpl = async (url, opts) => {
    assert.match(url, /\/collections\/papers\/points\?wait=true$/);
    const body = JSON.parse(opts.body);
    assert.equal(body.points[0].id, "p1");
    return { ok: true, status: 200, text: async () => JSON.stringify({ result: { status: "completed" }, status: "ok" }) };
  };
  const r = await upsertPoints("papers", [{ id: "p1", vector: [0.1] }], { fetchImpl });
  assert.equal(r.status, "ok");
});

test("search posts and returns normalized hits (injected fetch)", async () => {
  const fetchImpl = async (url, opts) => {
    assert.match(url, /\/points\/search$/);
    const body = JSON.parse(opts.body);
    assert.deepEqual(body.vector, [0.5, 0.6]);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ result: [{ id: 1, score: 0.99, payload: { doi: "x" } }] }),
    };
  };
  const hits = await search("papers", [0.5, 0.6], { limit: 1 }, { fetchImpl });
  assert.deepEqual(hits, [{ id: 1, score: 0.99, payload: { doi: "x" } }]);
});

test("search in env fixture mode uses opts.fixture", async () => {
  process.env.ADAPTER_FIXTURE_MODE = "1";
  try {
    const hits = await search("papers", [0.1], {}, { fixture: { result: [{ id: 2, score: 0.5 }] } });
    assert.deepEqual(hits, [{ id: 2, score: 0.5, payload: null }]);
  } finally {
    delete process.env.ADAPTER_FIXTURE_MODE;
  }
});
