// iframe-embed-resolver.test.mjs — official providers resolve; unsafe refused (EE2-12).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveEmbed,
  isEmbeddable,
  EmbedRefusedError,
  ALLOWED_PROVIDERS,
  EMBED_ALLOWLIST,
  KNOWN_SCRAPER_HOSTS,
} from "./iframe-embed-resolver.mjs";

// ---- ALLOW: official providers resolve to official-player embeds ----------

test("youtube watch URL → youtube-nocookie embed", () => {
  const d = resolveEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(d.provider, "youtube");
  assert.equal(d.id, "dQw4w9WgXcQ");
  assert.equal(d.embedHost, "www.youtube-nocookie.com");
  assert.match(d.embedUrl, /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
  assert.equal(d.clickToStart, true);
  // never same-origin+scripts together
  assert.ok(!/allow-same-origin/.test(d.sandbox));
});

test("youtu.be short link + /shorts + /embed all resolve", () => {
  assert.equal(resolveEmbed("https://youtu.be/dQw4w9WgXcQ").id, "dQw4w9WgXcQ");
  assert.equal(resolveEmbed("https://www.youtube.com/shorts/dQw4w9WgXcQ").id, "dQw4w9WgXcQ");
  assert.equal(resolveEmbed("https://www.youtube.com/embed/dQw4w9WgXcQ").id, "dQw4w9WgXcQ");
});

test("vimeo resolves to player.vimeo.com with dnt", () => {
  const d = resolveEmbed("https://vimeo.com/123456789");
  assert.equal(d.provider, "vimeo");
  assert.match(d.embedUrl, /^https:\/\/player\.vimeo\.com\/video\/123456789\?dnt=1$/);
});

test("dailymotion + dai.ly resolve", () => {
  const a = resolveEmbed("https://www.dailymotion.com/video/x8abcde");
  assert.equal(a.provider, "dailymotion");
  assert.match(a.embedUrl, /geo\.dailymotion\.com/);
  const b = resolveEmbed("https://dai.ly/x8abcde");
  assert.equal(b.id, "x8abcde");
});

test("3speak watch URL resolves to its official embed", () => {
  const d = resolveEmbed("https://3speak.tv/watch?v=alice/abc-123");
  assert.equal(d.provider, "threespeak");
  assert.equal(d.id, "alice/abc-123");
  assert.match(d.embedUrl, /3speak\.tv\/embed\?v=alice\/abc-123/);
});

test("internet archive PD film resolves", () => {
  const d = resolveEmbed("https://archive.org/details/night_of_the_living_dead");
  assert.equal(d.provider, "archive");
  assert.match(d.embedUrl, /archive\.org\/embed\/night_of_the_living_dead/);
});

test("provider + id form resolves without a URL", () => {
  const d = resolveEmbed({ provider: "youtube", id: "dQw4w9WgXcQ" });
  assert.equal(d.embedHost, "www.youtube-nocookie.com");
});

test("ALLOWED_PROVIDERS matches the allowlist keys", () => {
  assert.deepEqual([...ALLOWED_PROVIDERS].sort(), ["archive", "dailymotion", "threespeak", "vimeo", "youtube"]);
  assert.equal(Object.keys(EMBED_ALLOWLIST).length, 5);
});

// ---- DENY: unknown/unsafe sources are refused -----------------------------

test("known scraper/piracy iframe hosts are refused with SCRAPER_HOST", () => {
  for (const host of ["2embed.cc", "vidsrc.to", "gomovies.sx"]) {
    assert.ok(KNOWN_SCRAPER_HOSTS.includes(host));
    try {
      resolveEmbed(`https://${host}/embed/movie/tt1375666`);
      assert.fail(`expected refusal for ${host}`);
    } catch (e) {
      assert.ok(e instanceof EmbedRefusedError);
      assert.equal(e.code, "SCRAPER_HOST");
    }
  }
});

test("arbitrary unknown host refused (deny by default)", () => {
  assert.throws(
    () => resolveEmbed("https://evil.example.com/embed/x"),
    (e) => e instanceof EmbedRefusedError && e.code === "HOST_NOT_ALLOWED",
  );
});

test("look-alike host (youtube.com.evil.tld) is NOT matched as youtube", () => {
  assert.throws(
    () => resolveEmbed("https://www.youtube.com.evil.tld/watch?v=dQw4w9WgXcQ"),
    (e) => e instanceof EmbedRefusedError && e.code === "HOST_NOT_ALLOWED",
  );
});

test("non-https schemes refused before any host check", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "file:///etc/passwd",
  ]) {
    assert.throws(() => resolveEmbed(url), (e) => e instanceof EmbedRefusedError);
  }
});

test("script-smell input is refused (Samy-worm rule)", () => {
  assert.throws(
    () => resolveEmbed("https://www.youtube.com/watch?v=<script>"),
    (e) => e instanceof EmbedRefusedError && (e.code === "SCRIPT_SMELL" || e.code === "BAD_ID"),
  );
  // a script-bearing id via provider+id form is refused too
  assert.throws(
    () => resolveEmbed({ provider: "youtube", id: "javascript:alert" }),
    (e) => e instanceof EmbedRefusedError && e.code === "BAD_ID",
  );
});

test("malformed / missing id refused", () => {
  // youtube id must be 11 url-safe chars
  assert.throws(
    () => resolveEmbed({ provider: "youtube", id: "short" }),
    (e) => e instanceof EmbedRefusedError && e.code === "BAD_ID",
  );
  // a youtube URL with no v param → NO_ID
  assert.throws(
    () => resolveEmbed("https://www.youtube.com/feed/subscriptions"),
    (e) => e instanceof EmbedRefusedError && e.code === "NO_ID",
  );
});

test("unknown provider via provider+id form refused", () => {
  assert.throws(
    () => resolveEmbed({ provider: "2embed", id: "x" }),
    (e) => e instanceof EmbedRefusedError && e.code === "PROVIDER_NOT_ALLOWED",
  );
});

test("empty input refused", () => {
  assert.throws(() => resolveEmbed(""), (e) => e instanceof EmbedRefusedError && e.code === "EMPTY_INPUT");
  assert.throws(() => resolveEmbed({}), (e) => e instanceof EmbedRefusedError && e.code === "EMPTY_INPUT");
});

test("descriptor never emits script/srcdoc and only points at the official host", () => {
  const d = resolveEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  const blob = JSON.stringify(d).toLowerCase();
  assert.ok(!blob.includes("<script"));
  assert.ok(!blob.includes("srcdoc"));
  assert.ok(!blob.includes("javascript:"));
  assert.ok(d.embedUrl.startsWith("https://www.youtube-nocookie.com/"));
});

test("isEmbeddable predicate: true for official, false for scraper", () => {
  assert.equal(isEmbeddable("https://vimeo.com/123456789"), true);
  assert.equal(isEmbeddable("https://2embed.cc/embed/tt1"), false);
  assert.equal(isEmbeddable("https://evil.example.com"), false);
});
