// iframe-embed-resolver.mjs — PURE official-player embed resolver (EE2-12).
//
// The CODE form of the SoapBox §3a/§3b legal + safety line:
//   "Embed aggregator: YouTube/Dailymotion/Vimeo/3Speak official players.
//    REFUSE: 2Embed/scraper-iframe 'free current movies' = pirated + malware."
//   "ZERO arbitrary JS (the Samy-worm rule, doubly so with wallets)."
//
// Given a media URL (or a provider + id), this resolver returns the OFFICIAL
// embed descriptor for an allow-listed source, or REFUSES. It is a *pure*
// function module: no network, no DOM, no I/O — so it is trivially testable and
// can never be tricked into "just trying" an arbitrary host.
//
// WHY THIS SHAPE (threat model):
//   1. Samy-worm / self-XSS rule: an embed must NEVER carry attacker-supplied
//      JavaScript. We therefore (a) only ever emit a sanctioned <iframe> to a
//      hard-coded official-player origin, (b) never emit <script>, srcdoc, or a
//      data:/javascript: URL, and (c) reject any input that smells like script.
//   2. Open-redirect / scraper-iframe ("2Embed", "vidsrc", etc.) = pirated +
//      malware. The resolver works on an ALLOW-list (deny by default): an
//      unknown host is refused, not "passed through".
//   3. Privacy: official embeds get the privacy-preserving host where the
//      provider offers one (youtube-nocookie.com) and a fixed sandbox + allow
//      policy, limiting the third-party tracking surface (ties to the H5
//      deanonymization note's "limit third-party surface" posture).
//
// The output is a *descriptor* (provider, embedUrl, sandbox, allow, referrer
// policy, clickToStart) — the render layer turns it into an <iframe>. The
// resolver deliberately does not render; it only decides + builds the safe URL.

// --------------------------------------------------------------------------
// The allow-list — the ONLY sources that ever resolve. Deny by default.
// --------------------------------------------------------------------------
//
// Each entry: how to recognise the host(s), how to pull an id out of a watch
// URL, and how to build the OFFICIAL-player embed URL. Hosts are matched on the
// exact registrable host or an explicit subdomain — never a substring (so
// "youtube.com.evil.tld" does NOT match).
export const EMBED_ALLOWLIST = Object.freeze({
  youtube: {
    provider: "youtube",
    label: "YouTube",
    // Privacy-preserving official player host.
    hosts: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"],
    embedHost: "www.youtube-nocookie.com",
    idPattern: /^[A-Za-z0-9_-]{11}$/,
    extractId(u) {
      if (u.hostname === "youtu.be") return strip(u.pathname);
      if (u.pathname.startsWith("/embed/")) return strip(u.pathname.slice("/embed/".length));
      if (u.pathname.startsWith("/shorts/")) return strip(u.pathname.slice("/shorts/".length));
      return u.searchParams.get("v");
    },
    buildEmbedUrl(id) {
      // No autoplay JS, no related-channel leakage, modest branding.
      return `https://www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1`;
    },
  },
  vimeo: {
    provider: "vimeo",
    label: "Vimeo",
    hosts: ["vimeo.com", "www.vimeo.com", "player.vimeo.com"],
    embedHost: "player.vimeo.com",
    idPattern: /^\d{6,12}$/,
    extractId(u) {
      if (u.hostname === "player.vimeo.com") {
        const m = u.pathname.match(/\/video\/(\d+)/);
        return m ? m[1] : null;
      }
      const m = u.pathname.match(/\/(\d+)/);
      return m ? m[1] : null;
    },
    buildEmbedUrl(id) {
      return `https://player.vimeo.com/video/${id}?dnt=1`;
    },
  },
  dailymotion: {
    provider: "dailymotion",
    label: "Dailymotion",
    hosts: ["dailymotion.com", "www.dailymotion.com", "dai.ly", "geo.dailymotion.com"],
    embedHost: "geo.dailymotion.com",
    idPattern: /^[A-Za-z0-9]{5,12}$/,
    extractId(u) {
      if (u.hostname === "dai.ly") return strip(u.pathname);
      if (u.pathname.startsWith("/embed/video/")) return strip(u.pathname.slice("/embed/video/".length));
      const m = u.pathname.match(/\/video\/([A-Za-z0-9]+)/);
      return m ? m[1] : null;
    },
    buildEmbedUrl(id) {
      return `https://geo.dailymotion.com/player.html?video=${id}`;
    },
  },
  threespeak: {
    provider: "threespeak",
    label: "3Speak",
    hosts: ["3speak.tv", "www.3speak.tv"],
    embedHost: "3speak.tv",
    // 3Speak ids are author/permlink pairs.
    idPattern: /^[a-z0-9.-]+\/[A-Za-z0-9-]+$/,
    extractId(u) {
      // /watch?v=author/permlink  OR  /embed?v=author/permlink
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/watch\/([a-z0-9.-]+\/[A-Za-z0-9-]+)/);
      return m ? m[1] : null;
    },
    buildEmbedUrl(id) {
      return `https://3speak.tv/embed?v=${id}`;
    },
  },
  archive: {
    provider: "archive",
    label: "Internet Archive",
    // PD films (Doc §3b: "host freely: PD films ... embedding IA's player").
    hosts: ["archive.org", "www.archive.org"],
    embedHost: "archive.org",
    idPattern: /^[A-Za-z0-9._-]{2,128}$/,
    extractId(u) {
      if (u.pathname.startsWith("/embed/")) return strip(u.pathname.slice("/embed/".length));
      const m = u.pathname.match(/\/details\/([A-Za-z0-9._-]+)/);
      return m ? m[1] : null;
    },
    buildEmbedUrl(id) {
      return `https://archive.org/embed/${id}`;
    },
  },
});

// Known scraper / piracy iframe hosts — surfaced in the refusal reason so a
// caller can log *why*. NB: refusal does NOT depend on this list (deny-by-
// default already refuses them); it only enriches the error.
export const KNOWN_SCRAPER_HOSTS = Object.freeze([
  "2embed.cc", "2embed.to", "2embed.ru", "vidsrc.to", "vidsrc.me", "vidsrc.xyz",
  "vidsrc.net", "embedsito.com", "fembed.com", "streamtape.com", "doodstream.com",
  "mixdrop.co", "upstream.to", "vidcloud.co", "gomovies.sx", "fmovies.to",
]);

export class EmbedRefusedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "EmbedRefusedError";
    this.code = details.code ?? "REFUSED";
    this.details = details;
  }
}

// --------------------------------------------------------------------------
// resolveEmbed — the one entry point.
// --------------------------------------------------------------------------
//
// Input (one of):
//   resolveEmbed("https://www.youtube.com/watch?v=...")
//   resolveEmbed({ url: "https://vimeo.com/12345678" })
//   resolveEmbed({ provider: "youtube", id: "dQw4w9WgXcQ" })
//
// Returns a frozen safe descriptor; throws EmbedRefusedError on anything not on
// the allow-list or anything that smells like injected script.
export function resolveEmbed(input) {
  const arg = typeof input === "string" ? { url: input } : input ?? {};
  const { url = null, provider = null, id = null } = arg;

  // Path A: explicit provider + id (no URL parse needed, but still validated).
  if (provider != null && id != null && url == null) {
    return resolveByProviderId(provider, id);
  }

  if (url == null || String(url).trim() === "") {
    throw new EmbedRefusedError("no url or provider+id supplied", { code: "EMPTY_INPUT" });
  }

  const raw = String(url).trim();

  // Hard refusal #1: anything that is not plain https. Blocks javascript:,
  // data:, blob:, file:, and bare http (downgrade) before we even parse a host.
  if (!/^https:\/\//i.test(raw)) {
    throw new EmbedRefusedError("only absolute https:// URLs are allowed", {
      code: "BAD_SCHEME",
      url: raw.slice(0, 120),
    });
  }
  // Hard refusal #2: anything that smells like injected script. Defense in
  // depth — a well-formed https URL should never contain these.
  if (containsScriptSmell(raw)) {
    throw new EmbedRefusedError("input contains script-like content; refused", {
      code: "SCRIPT_SMELL",
      url: raw.slice(0, 120),
    });
  }

  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new EmbedRefusedError("unparseable URL", { code: "BAD_URL", url: raw.slice(0, 120) });
  }

  const host = u.hostname.toLowerCase();

  // Deny-by-default: find the single allow-list entry that claims this exact host.
  const entry = findEntryForHost(host);
  if (!entry) {
    const scraper = KNOWN_SCRAPER_HOSTS.includes(host);
    throw new EmbedRefusedError(
      scraper
        ? `host '${host}' is a known scraper/piracy iframe source; refused`
        : `host '${host}' is not on the official-embed allow-list; refused`,
      { code: scraper ? "SCRAPER_HOST" : "HOST_NOT_ALLOWED", host },
    );
  }

  const extracted = entry.extractId(u);
  return finalize(entry, extracted);
}

function resolveByProviderId(provider, id) {
  const key = String(provider).toLowerCase();
  const entry =
    EMBED_ALLOWLIST[key] ??
    Object.values(EMBED_ALLOWLIST).find((e) => e.provider === key);
  if (!entry) {
    throw new EmbedRefusedError(`provider '${provider}' is not on the allow-list; refused`, {
      code: "PROVIDER_NOT_ALLOWED",
      provider: key,
    });
  }
  return finalize(entry, String(id).trim());
}

// Validate the id against the provider's pattern and build the safe descriptor.
function finalize(entry, id) {
  if (id == null || String(id).trim() === "") {
    throw new EmbedRefusedError(`could not extract a ${entry.provider} media id`, {
      code: "NO_ID",
      provider: entry.provider,
    });
  }
  const clean = String(id).trim();
  if (containsScriptSmell(clean) || !entry.idPattern.test(clean)) {
    throw new EmbedRefusedError(`'${clean}' is not a valid ${entry.provider} id; refused`, {
      code: "BAD_ID",
      provider: entry.provider,
      id: clean.slice(0, 64),
    });
  }
  const embedUrl = entry.buildEmbedUrl(clean);
  // Belt-and-suspenders: the URL we just built MUST point at the official
  // embed host. If a provider helper were ever mis-edited, fail closed.
  let built;
  try {
    built = new URL(embedUrl);
  } catch {
    throw new EmbedRefusedError("internal: built embed URL is invalid", { code: "INTERNAL" });
  }
  if (built.protocol !== "https:" || built.hostname.toLowerCase() !== entry.embedHost) {
    throw new EmbedRefusedError("internal: built embed URL left the official host", {
      code: "INTERNAL_HOST",
      got: built.hostname,
      expected: entry.embedHost,
    });
  }

  return Object.freeze({
    ok: true,
    provider: entry.provider,
    label: entry.label,
    id: clean,
    embedUrl,
    embedHost: entry.embedHost,
    // The render layer MUST apply these. No `allow-scripts`+`allow-same-origin`
    // pairing (that combo defeats the sandbox); no allow-top-navigation.
    sandbox: "allow-scripts allow-presentation allow-popups allow-popups-to-escape-sandbox",
    allow: "accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen",
    referrerPolicy: "strict-origin-when-cross-origin",
    // Samy-worm rule + UX: never autoplay arbitrary embeds; require a user click.
    clickToStart: true,
    allowFullscreen: true,
  });
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

// Match a host to its allow-list entry by exact host or registrable-domain
// suffix (".youtube.com"). Never a bare substring.
function findEntryForHost(host) {
  for (const entry of Object.values(EMBED_ALLOWLIST)) {
    for (const h of entry.hosts) {
      if (host === h || host.endsWith(`.${h}`)) return entry;
    }
  }
  return null;
}

function strip(s) {
  return String(s).replace(/^\/+/, "").replace(/\/+$/, "").trim();
}

// Reject anything that looks like an attempt to smuggle script/markup. Applied
// to both raw URLs and extracted ids.
function containsScriptSmell(s) {
  const v = String(s).toLowerCase();
  return (
    v.includes("<") ||
    v.includes(">") ||
    v.includes("javascript:") ||
    v.includes("data:") ||
    v.includes("vbscript:") ||
    v.includes("onerror=") ||
    v.includes("onload=") ||
    v.includes("srcdoc") ||
    v.includes("\\x") ||
    v.includes("%3c") || // encoded '<'
    v.includes("&#")
  );
}

// Convenience predicate for callers that just want a yes/no without a throw.
export function isEmbeddable(input) {
  try {
    resolveEmbed(input);
    return true;
  } catch {
    return false;
  }
}

export const ALLOWED_PROVIDERS = Object.freeze(Object.values(EMBED_ALLOWLIST).map((e) => e.provider));
