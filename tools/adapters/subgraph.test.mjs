// W4 — subgraph.mjs tests. Fixture-based: no network, no base.mjs requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRequestBody,
  parseResponse,
  query,
  SubgraphGraphQLError,
  SubgraphHttpError,
} from "./subgraph.mjs";

test("buildRequestBody includes variables and operationName when present", () => {
  const b = buildRequestBody("query Q($n:Int){swaps(first:$n){id}}", { n: 5 }, "Q");
  assert.equal(b.query, "query Q($n:Int){swaps(first:$n){id}}");
  assert.deepEqual(b.variables, { n: 5 });
  assert.equal(b.operationName, "Q");
});

test("buildRequestBody omits empty variables", () => {
  const b = buildRequestBody("{ pairs { id } }", {});
  assert.equal("variables" in b, false);
});

test("buildRequestBody rejects empty query", () => {
  assert.throws(() => buildRequestBody("   "), /non-empty string/);
});

test("parseResponse returns data on success", () => {
  const fixture = { data: { swaps: [{ id: "0xabc-1", amount0In: "1000" }] } };
  const data = parseResponse(fixture);
  assert.deepEqual(data.swaps[0], { id: "0xabc-1", amount0In: "1000" });
});

test("parseResponse throws typed GraphQL error", () => {
  const fixture = { errors: [{ message: "bad field" }, { message: "nope" }] };
  assert.throws(
    () => parseResponse(fixture),
    (e) => e instanceof SubgraphGraphQLError && /bad field; nope/.test(e.message)
  );
});

test("parseResponse throws when data missing", () => {
  assert.throws(() => parseResponse({ extensions: {} }), /missing `data`/);
});

test("query in fixture mode returns parsed data without network", async () => {
  const fixture = { data: { pairs: [{ id: "0xpair" }] } };
  const data = await query("http://unused", "{ pairs { id } }", {}, { fixture });
  assert.deepEqual(data.pairs, [{ id: "0xpair" }]);
});

test("query uses injected fetchImpl and parses HTTP errors", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    text: async () => JSON.stringify({ errors: [{ message: "boom" }] }),
  });
  await assert.rejects(
    () => query("http://node/graphql", "{ x }", {}, { fetchImpl }),
    (e) => e instanceof SubgraphHttpError && e.status === 500
  );
});

test("query with injected fetch returns data on 200", async () => {
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.query, "{ tokens { id } }");
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { tokens: [] } }) };
  };
  const data = await query("https://node/graphql", "{ tokens { id } }", {}, { fetchImpl });
  assert.deepEqual(data, { tokens: [] });
});
