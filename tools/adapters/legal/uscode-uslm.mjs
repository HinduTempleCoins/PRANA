// uscode-uslm.mjs — typed US Code USLM XML client (SoapBox BB2-4).
//
// READ-ONLY. uscode.house.gov (Office of the Law Revision Counsel) publishes the
// United States Code in USLM (United States Legislative Markup) XML. There is no
// JSON API; releases are static XML files, e.g.:
//   https://uscode.house.gov/download/releasepoints/.../xml_usc26@...zip
// and individual title/section XML. This client fetches a USLM XML document and
// parses out section structure into typed records with a dependency-free,
// regex-based reader (no XML lib needed for the fields SoapBox indexes).
//
// Wired through the shared adapter base via LegalHttpClient.getText: same
// rate-limit/retry/cache/typed-error policy as the JSON adapters, plus fixture
// mode (serves a recorded .xml file). No API key (the site is fully public);
// there is nothing to read from env here.

import { TokenBucket, TTLCache, AdapterError } from "../base.mjs";
import { LegalHttpClient } from "./legal-base.mjs";

export const USCODE_BASE_URL = "https://uscode.house.gov";

export class USCodeUSLMClient {
  constructor({
    baseUrl = USCODE_BASE_URL,
    fixtureMode = false,
    rateLimiter = new TokenBucket({ capacity: 3, refillPerSec: 0.5 }),
    cache = new TTLCache({ ttlMs: 600_000 }),
    http = null,
    ...httpOpts
  } = {}) {
    this.http =
      http ??
      new LegalHttpClient({
        baseUrl,
        fixtureMode,
        rateLimiter,
        cache,
        fixtureResolver: () => "uscode-uslm-title.xml",
        ...httpOpts,
      });
  }

  // Fetch a USLM XML document by relative path/URL and parse its sections.
  // Returns { title, sections: [typed section rows] }.
  async fetchDocument(pathOrUrl, { fixture = "uscode-uslm-title.xml" } = {}) {
    if (!pathOrUrl) throw new AdapterError("fetchDocument: pathOrUrl is required");
    const xml = await this.http.getText(pathOrUrl, { fixture });
    return parseUSLM(xml);
  }

  // Convenience: build the conventional release-point path for one title's XML
  // and fetch it. `title` like "26" (Internal Revenue Code).
  async getTitle(title, { fixture = "uscode-uslm-title.xml" } = {}) {
    if (title == null) throw new AdapterError("getTitle: title is required");
    const path = `/download/releasepoints/us/pl/current/xml_usc${encodeURIComponent(title)}.xml`;
    return this.fetchDocument(path, { fixture });
  }

  // search(): USLM is static XML, so "search" is a client-side filter over the
  // parsed sections of one already-fetched document (substring on heading/num).
  async searchInDocument(pathOrUrl, { query, fixture = "uscode-uslm-title.xml" } = {}) {
    if (!query || !String(query).trim()) throw new AdapterError("searchInDocument: query is required");
    const doc = await this.fetchDocument(pathOrUrl, { fixture });
    const q = String(query).trim().toLowerCase();
    const results = doc.sections.filter(
      (s) =>
        (s.heading && s.heading.toLowerCase().includes(q)) ||
        (s.num && s.num.toLowerCase().includes(q)) ||
        (s.text && s.text.toLowerCase().includes(q)),
    );
    return { title: doc.title, count: results.length, results };
  }
}

// ---- USLM parsing (dependency-free) ---------------------------------------

// Minimal USLM reader: pulls the document <title> heading and each <section>'s
// <num value="..."> + <heading> + concatenated text. Good enough for indexing;
// not a full XML parser. Throws AdapterError on a non-USLM body.
export function parseUSLM(xml) {
  if (typeof xml !== "string" || !/<\s*uslm|<\s*section|<\s*title/i.test(xml)) {
    throw new AdapterError("parseUSLM: input does not look like USLM XML", {
      details: { head: String(xml).slice(0, 80) },
    });
  }

  const titleHeading = matchInner(xml, "title", "heading") ?? null;

  const sections = [];
  const sectionRe = /<section\b[^>]*>([\s\S]*?)<\/section>/gi;
  let m;
  while ((m = sectionRe.exec(xml)) !== null) {
    const inner = m[1];
    const numMatch = /<num\b[^>]*\bvalue\s*=\s*"([^"]*)"/i.exec(inner) || /<num\b[^>]*>([\s\S]*?)<\/num>/i.exec(inner);
    const num = numMatch ? stripTags(numMatch[1]).trim() : null;
    const headingMatch = /<heading\b[^>]*>([\s\S]*?)<\/heading>/i.exec(inner);
    const heading = headingMatch ? stripTags(headingMatch[1]).trim() : null;
    const idMatch = /<section\b[^>]*\b(?:id|identifier)\s*=\s*"([^"]*)"/i.exec(m[0]);
    sections.push({
      identifier: idMatch ? idMatch[1] : null,
      num,
      heading,
      text: collapse(stripTags(inner)),
    });
  }

  return { title: titleHeading, sections };
}

function matchInner(xml, outerTag, innerTag) {
  const outer = new RegExp(`<${outerTag}\\b[^>]*>([\\s\\S]*?)<\\/${outerTag}>`, "i").exec(xml);
  const scope = outer ? outer[1] : xml;
  const inner = new RegExp(`<${innerTag}\\b[^>]*>([\\s\\S]*?)<\\/${innerTag}>`, "i").exec(scope);
  return inner ? collapse(stripTags(inner[1])) : null;
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, " ");
}

function collapse(s) {
  return String(s).replace(/\s+/g, " ").trim();
}
