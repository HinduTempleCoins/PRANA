// jamendo.test.mjs — offline tests for the Jamendo adapter (EE2-1).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  JamendoClient,
  classifyCcLicense,
  resolveJamendoClientId,
  JAMENDO_BASE_URL,
  JAMENDO_FALLBACK_CLIENT_ID,
} from "./jamendo.mjs";
import { HttpClient, AdapterError } from "../base.mjs";

function fixtureClient(opts = {}) {
  return new JamendoClient({ fixtureMode: true, ...opts });
}

test("base url default points at the public v3 API", () => {
  assert.match(JAMENDO_BASE_URL, /api\.jamendo\.com\/v3\.0$/);
});

test("client id falls back to documented placeholder, env overrides", () => {
  assert.equal(resolveJamendoClientId({}), JAMENDO_FALLBACK_CLIENT_ID);
  assert.equal(resolveJamendoClientId({ JAMENDO_CLIENT_ID: "real123" }), "real123");
});

test("classifyCcLicense tiers PD / BY / BY-NC-SA correctly", () => {
  const pd = classifyCcLicense("http://creativecommons.org/publicdomain/zero/1.0/");
  assert.equal(pd.tier, "public-domain");
  assert.equal(pd.commercialOk, true);

  const by = classifyCcLicense("http://creativecommons.org/licenses/by/3.0/");
  assert.equal(by.tier, "cc-by");
  assert.equal(by.shareAlike, false);
  assert.equal(by.commercialOk, true);
  assert.equal(by.derivativesOk, true);

  const byncsa = classifyCcLicense("http://creativecommons.org/licenses/by-nc-sa/4.0/");
  assert.equal(byncsa.tier, "cc-by-nc-sa");
  assert.equal(byncsa.shareAlike, true);
  assert.equal(byncsa.commercialOk, false);
  assert.equal(byncsa.ccVersion, "4.0");

  const nd = classifyCcLicense("http://creativecommons.org/licenses/by-nc-nd/3.0/");
  assert.equal(nd.derivativesOk, false);
});

test("search shapes tracks + surfaces license/attribution", async () => {
  const j = fixtureClient();
  const rows = await j.search({ query: "temple" });
  assert.equal(rows.length, 2);
  const t = rows[0];
  assert.equal(t.source, "jamendo");
  assert.equal(t.id, "1886433");
  assert.equal(t.title, "Sunrise Over the Nile");
  assert.equal(t.artist, "Komiku");
  // license surfaced + tiered
  assert.equal(t.license.tier, "cc-by");
  assert.equal(t.attribution.requiredCredit, true);
  assert.equal(t.attribution.commercialOk, true);
  // second track is BY-NC-SA
  assert.equal(rows[1].license.tier, "cc-by-nc-sa");
  assert.equal(rows[1].attribution.shareAlike, true);
  assert.equal(rows[1].attribution.commercialOk, false);
});

test("search requires a non-empty query", async () => {
  const j = fixtureClient();
  await assert.rejects(() => j.search({ query: "" }), AdapterError);
  await assert.rejects(() => j.search({}), AdapterError);
});

test("fetchById returns one shaped track (PD here)", async () => {
  const j = fixtureClient();
  const t = await j.fetchById("1886433");
  assert.equal(t.id, "1886433");
  assert.equal(t.license.tier, "public-domain");
  assert.equal(t.attribution.requiredCredit, false);
});

test("fetchById requires an id", async () => {
  const j = fixtureClient();
  await assert.rejects(() => j.fetchById(""), AdapterError);
});

test("Jamendo-reported failure status throws AdapterError", async () => {
  const http = new HttpClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ headers: { status: "failed", error_message: "bad key" }, results: [] }),
    }),
  });
  const j = new JamendoClient({ http });
  await assert.rejects(() => j.search({ query: "x" }), AdapterError);
});
