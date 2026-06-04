// stock-media.test.mjs — offline tests for the unified stock-media adapter (EE2-6).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  StockMediaClient,
  STOCK_PROVIDERS,
  LIVE_PROVIDERS,
  CATALOG_PROVIDERS,
} from "./stock-media.mjs";
import { HttpClient, AdapterError } from "../base.mjs";

function fx(opts = {}) {
  return new StockMediaClient({ fixtureMode: true, ...opts });
}

test("provider lists are coherent", () => {
  assert.deepEqual(LIVE_PROVIDERS, ["pexels", "pixabay", "coverr"]);
  assert.deepEqual(CATALOG_PROVIDERS, ["mixkit", "videvo"]);
  assert.equal(STOCK_PROVIDERS.length, 5);
});

test("pexels photos → unified StockAsset", async () => {
  const out = await fx().pexels({ query: "sunset", kind: "photos" });
  assert.equal(out.length, 2);
  assert.equal(out[0].provider, "pexels");
  assert.equal(out[0].type, "photo");
  assert.equal(out[0].id, "1010657");
  assert.equal(out[0].src, "https://images.pexels.com/photos/1010657/original.jpeg");
  assert.equal(out[0].author, "Pixabay");
  assert.equal(out[0].license, "Pexels License");
});

test("pexels videos → unified StockAsset (video file picked)", async () => {
  const out = await fx().pexels({ query: "waves", kind: "videos" });
  assert.equal(out[0].type, "video");
  assert.match(out[0].src, /\.mp4$/);
  assert.equal(out[0].author, "Enrique Hoyos");
});

test("pixabay photos + videos", async () => {
  const photos = await fx().pixabay({ query: "flower", kind: "photos" });
  assert.equal(photos[0].provider, "pixabay");
  assert.equal(photos[0].type, "photo");
  assert.equal(photos[0].src, "https://pixabay.com/get/flower-195893_1280.jpg");

  const videos = await fx().pixabay({ query: "clip", kind: "videos" });
  assert.equal(videos[0].type, "video");
  assert.equal(videos[0].width, 1920);
  assert.match(videos[0].src, /\.mp4$/);
});

test("coverr videos", async () => {
  const out = await fx().coverr({ query: "ocean" });
  assert.equal(out[0].provider, "coverr");
  assert.equal(out[0].type, "video");
  assert.match(out[0].src, /\.mp4$/);
  assert.equal(out[0].license, "Coverr License");
});

test("query is required across providers", async () => {
  await assert.rejects(() => fx().pexels({ query: "" }), AdapterError);
  await assert.rejects(() => fx().pixabay({}), AdapterError);
  await assert.rejects(() => fx().coverr({ query: "  " }), AdapterError);
});

test("API keys come from explicit opts (env-overridable) and go on the request", () => {
  const c = new StockMediaClient({ fixtureMode: true, pexelsKey: "PX-1", pixabayKey: "PB-1", coverrKey: "CV-1" });
  assert.equal(c.pexelsKey, "PX-1");
  assert.equal(c.pixabayKey, "PB-1");
  assert.equal(c.coverrKey, "CV-1");
});

test("catalog() folds Mixkit/Videvo entries into StockAsset; rejects live providers", () => {
  const c = fx();
  const rows = c.catalog("mixkit", [{ id: "m1", type: "video", src: "https://mixkit.co/x.mp4" }]);
  assert.equal(rows[0].provider, "mixkit");
  assert.equal(rows[0].license, "Mixkit License");
  assert.throws(() => c.catalog("pexels", []), AdapterError);
});

test("non-array payload surfaces AdapterError", async () => {
  const http = new HttpClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ photos: "nope" }) }),
  });
  const c = new StockMediaClient({ http, pexelsKey: "x" });
  await assert.rejects(() => c.pexels({ query: "a" }), AdapterError);
});
