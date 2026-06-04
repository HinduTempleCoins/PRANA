// W10 — self-check for the consumer-matrix linter against the live directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkConsumerMatrix } from "./check-consumer-matrix.mjs";

test("every adapter in the directory has a consumer and no consumer dangles", async () => {
  const { adapters, orphanAdapters, danglingConsumers } = await checkConsumerMatrix();
  assert.ok(adapters.length >= 4, `expected >=4 adapters, found ${adapters.length}`);
  // The W4/W5/W8/W10-relevant adapters must be present and mapped.
  for (const a of ["subgraph.mjs", "qdrant.mjs", "blockscout.mjs"]) {
    assert.ok(adapters.includes(a), `missing adapter ${a}`);
  }
  assert.deepEqual(orphanAdapters, [], "adapters without a consumer");
  assert.deepEqual(danglingConsumers, [], "consumers referencing missing adapters");
});
