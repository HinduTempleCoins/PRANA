// wayback.test.mjs — offline tests for the Wayback adapter (DD2-5).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WaybackClient,
  WAYBACK_REPLAY_BASE,
  waybackFixtureName,
} from "./wayback.mjs";
import { LibraryHttpClient } from "./library-base.mjs";
import { AdapterError } from "../base.mjs";

function fixtureClient(opts = {}) {
  return new WaybackClient({ fixtureMode: true, ...opts });
}

test("available returns a closest-capture POINTER", async () => {
  const wb = fixtureClient();
  const r = await wb.available({ url: "example.com", timestamp: "2020" });
  assert.equal(r.available, true);
  assert.equal(r.snapshot.timestamp, "20200101000000");
  assert.match(r.snapshot.url, /^http:\/\/web\.archive\.org\/web\//);
  assert.equal(r.snapshot.status, "200");
});

test("available requires a url", async () => {
  const wb = fixtureClient();
  await assert.rejects(() => wb.available({}), AdapterError);
});

test("available with no snapshot returns available:false", async () => {
  const http = new LibraryHttpClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ archived_snapshots: {} }) }),
  });
  const wb = new WaybackClient({ availableHttp: http });
  const r = await wb.available({ url: "no-captures.example" });
  assert.equal(r.available, false);
  assert.equal(r.snapshot, null);
});

test("captures shapes CDX rows into capture-window pointers", async () => {
  const wb = fixtureClient();
  const r = await wb.captures({ url: "example.com" });
  assert.deepEqual(r.fields, [
    "urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length",
  ]);
  assert.equal(r.captures.length, 3);
  const first = r.captures[0];
  assert.equal(first.timestamp, "19970101000000");
  assert.equal(first.original, "http://example.com/");
  // each capture carries a ready replay POINTER (link), never bytes
  assert.equal(first.replayUrl, `${WAYBACK_REPLAY_BASE}/19970101000000/http://example.com/`);
});

test("captures requires a url", async () => {
  const wb = fixtureClient();
  await assert.rejects(() => wb.captures({}), AdapterError);
});

test("empty CDX array yields no captures", async () => {
  const http = new LibraryHttpClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }),
  });
  const wb = new WaybackClient({ cdxHttp: http });
  const r = await wb.captures({ url: "x.example" });
  assert.deepEqual(r, { fields: [], captures: [] });
});

test("replayUrl builds a link pointer (no fetch)", () => {
  const wb = fixtureClient();
  assert.equal(
    wb.replayUrl("2020-01-01", "http://example.com/"),
    `${WAYBACK_REPLAY_BASE}/20200101/http://example.com/`,
  );
});

test("fixture resolver routes available vs cdx", () => {
  assert.equal(waybackFixtureName("https://archive.org/wayback/available?url=x"), "wayback-available");
  assert.equal(waybackFixtureName("https://web.archive.org/cdx/search/cdx?url=x"), "wayback-cdx");
  assert.equal(waybackFixtureName("https://web.archive.org/other"), null);
});
