# YouTube-Embed Whitelist Player — spec (EE2-11)

> SoapBox Media layer, §3a/§3b. The profile player (MySpace/NeoPets
> reincarnation): expressive customization, **ZERO arbitrary JS**, click-to-start,
> official-iframe-only. This spec is the design; the enforcing code is
> `tools/media/iframe-embed-resolver.mjs` (EE2-12) and the machine-readable
> allow-list is `design/media/embed-whitelist.json`.

---

## 0. The one rule (why this exists)

The profile player lets users decorate a page and drop in media. The MySpace era
died of exactly one wound: **user-supplied content was allowed to run
JavaScript.** Samy Kamkar's 2005 worm ("samy is my hero") added a million friends
in 20 hours because a MySpace profile could smuggle script through a CSS/markup
sink. We carry **wallet keys in the same app** — a self-XSS here is not
"deface a profile", it is "drain a wallet". So the rule is absolute:

> **A profile / embed NEVER runs page-author-supplied JavaScript. The only script
> that ever executes inside an embed is the official provider's own player,
> loaded from the official provider origin inside a sandboxed iframe.**

This is the "be a *window* to licensed platforms, never a *host*" posture that
also keeps us on the right side of the law (Napster / Grokster / Pirate Bay all
died for hosting / indexing / inducing infringement; an official embed is a
window).

---

## 1. What the player is allowed to do

- Render an `<iframe>` to an **official-player URL on an allow-listed host only**
  (YouTube, Vimeo, Dailymotion, 3Speak, Internet Archive — see the allow-list).
- Apply a fixed, minimal sandbox and permissions policy (below). Authors cannot
  widen them.
- Offer cosmetic customization (themes, layout, colors) through a **structured,
  declarative** style system — NOT raw HTML/CSS the author types. Style is a set
  of typed tokens (color, font choice from a list, layout enum), serialized to a
  safe stylesheet by us, never `dangerouslySetInnerHTML` / `<style>` injection.

## 2. What the player must NEVER do

- Never inject author-supplied `<script>`, inline event handlers
  (`onclick=`, `onerror=`…), `javascript:`/`data:`/`vbscript:` URLs, `srcdoc`,
  or `<style>`/`<link>` the author controls.
- Never render an iframe to a host not on the allow-list (deny by default).
- Never use the `allow-scripts` + `allow-same-origin` sandbox combination
  together (that pairing lets the framed page remove its own sandbox).
- Never autoplay with sound; **click-to-start** (muted preview at most).
- Never proxy / scrape / rehost a video stream (that is hosting + likely piracy).

## 3. The iframe contract (what the render layer emits)

Every embed is rendered from the descriptor returned by `resolveEmbed()`:

```html
<iframe
  src="<descriptor.embedUrl>"               <!-- official host, https only -->
  sandbox="allow-scripts allow-presentation allow-popups allow-popups-to-escape-sandbox"
  allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
  referrerpolicy="strict-origin-when-cross-origin"
  allowfullscreen
  loading="lazy"></iframe>
```

- `sandbox` deliberately OMITS `allow-same-origin` and `allow-top-navigation`.
- `clickToStart: true` → render a poster + play button; only mount the iframe on
  user click (also a privacy win: no third-party load until the user opts in).
- The whole player document SHOULD additionally sit under a page CSP such as
  `frame-src` limited to the allow-listed embed hosts and `script-src 'self'`,
  so even a resolver bug cannot frame an off-list origin.

## 4. The allow-list (deny by default)

Source of truth: `design/media/embed-whitelist.json` (schema below), enforced by
`iframe-embed-resolver.mjs`. Five official players:

| provider     | watch-host examples                    | official embed host          |
| ------------ | -------------------------------------- | ---------------------------- |
| `youtube`    | youtube.com, youtu.be, m.youtube.com   | `www.youtube-nocookie.com`   |
| `vimeo`      | vimeo.com, player.vimeo.com            | `player.vimeo.com`           |
| `dailymotion`| dailymotion.com, dai.ly                | `geo.dailymotion.com`        |
| `threespeak` | 3speak.tv                              | `3speak.tv`                  |
| `archive`    | archive.org (PD films)                 | `archive.org`                |

Explicitly **refused** (non-exhaustive, deny-by-default already covers all
unknowns): 2Embed, vidsrc, embedsito/fembed, streamtape, doodstream, mixdrop,
gomovies, fmovies — "free current movies" scraper iframes = pirated + malware.

### allow-list JSON schema

```jsonc
{
  "version": 1,
  "providers": [
    {
      "provider": "youtube",      // stable key
      "label": "YouTube",
      "hosts": ["youtube.com", "youtu.be", ...],  // recognised watch hosts
      "embedHost": "www.youtube-nocookie.com",     // the ONLY host we frame
      "idPattern": "^[A-Za-z0-9_-]{11}$",           // validated before use
      "embedUrlTemplate": "https://www.youtube-nocookie.com/embed/{id}?rel=0&modestbranding=1"
    }
  ],
  "denyHosts": ["2embed.cc", "vidsrc.to", ...]      // informational; deny is default
}
```

## 5. Resolver behavior (the code contract — EE2-12)

`resolveEmbed(urlOrSpec)` is a **pure** function (no network, no DOM):

- Accepts `"https://…"`, `{ url }`, or `{ provider, id }`.
- Refuses, with a typed `EmbedRefusedError` + a machine code, when input is:
  non-https (`BAD_SCHEME`), script-smelling (`SCRIPT_SMELL`), an off-list host
  (`HOST_NOT_ALLOWED`), a known scraper (`SCRAPER_HOST`), an unparseable URL
  (`BAD_URL`), an unknown provider (`PROVIDER_NOT_ALLOWED`), a missing id
  (`NO_ID`), or a malformed id (`BAD_ID`).
- On success returns a frozen descriptor `{ provider, id, embedUrl, embedHost,
  sandbox, allow, referrerPolicy, clickToStart, allowFullscreen }` whose
  `embedUrl` is re-validated to point at the provider's official embed host
  (fail-closed if a builder were ever mis-edited).
- Host matching is exact-host or true subdomain suffix only — `youtube.com.evil.tld`
  does NOT match `youtube.com`.

## 6. Privacy alignment (H5 deanonymization note)

The embed surface is a third-party tracking vector. We minimize it: prefer the
provider's privacy host (`youtube-nocookie.com`, Vimeo `dnt=1`), set a tight
`referrerPolicy`, and **don't load the third-party iframe until the user clicks**
(`clickToStart`). This matches the wallet-layer "limit third-party surface /
damage-limitation" posture for a transparent-ledger app.
