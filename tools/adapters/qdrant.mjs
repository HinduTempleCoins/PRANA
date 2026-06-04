// W5 — Qdrant REST adapter (vector DB).
//
// Plain `fetch` against a Qdrant HTTP API (default http://localhost:6333).
// Exposes pure payload builders (unit-tested with fixtures) plus the three
// network operations: ensureCollection / upsertPoints / search.
//
// Softly depends on ./base.mjs for typed errors + fixture plumbing.

let base;
try {
  base = await import("./base.mjs");
} catch {
  base = null;
}

class FallbackAdapterError extends Error {
  constructor(message, { code, status, cause, details } = {}) {
    super(message);
    this.name = "AdapterError";
    if (cause !== undefined) this.cause = cause;
    this.details = { ...(details ?? {}), ...(code ? { code } : {}), ...(status != null ? { status } : {}) };
    if (code) this.code = code;
    if (status != null) this.status = status;
  }
}
const BaseAdapterError = base?.AdapterError ?? FallbackAdapterError;

export class AdapterError extends BaseAdapterError {
  constructor(message, opts = {}) {
    super(message, opts);
    if (opts.code) this.code = opts.code;
    if (opts.status != null) this.status = opts.status;
  }
}

export class QdrantHttpError extends AdapterError {
  constructor(message, status, body) {
    super(message, { code: "QDRANT_HTTP", status });
    this.name = "QdrantHttpError";
    this.body = body;
  }
}

export const DEFAULT_BASE_URL = "http://localhost:6333";
const VALID_DISTANCES = new Set(["Cosine", "Euclid", "Dot", "Manhattan"]);

function fixtureModeOn() {
  return process.env.ADAPTER_FIXTURE_MODE === "1";
}

// ---- pure payload builders (no I/O) ---------------------------------------

/** Body for PUT /collections/{name}. */
export function buildCreateCollectionBody(vectorSize, distance = "Cosine") {
  if (!Number.isInteger(vectorSize) || vectorSize <= 0) {
    throw new AdapterError("vectorSize must be a positive integer", {
      code: "QDRANT_BAD_VECTOR_SIZE",
    });
  }
  if (!VALID_DISTANCES.has(distance)) {
    throw new AdapterError(
      `distance must be one of ${[...VALID_DISTANCES].join(", ")}`,
      { code: "QDRANT_BAD_DISTANCE" }
    );
  }
  return { vectors: { size: vectorSize, distance } };
}

/** Body for PUT /collections/{name}/points. Validates each point. */
export function buildUpsertBody(points) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new AdapterError("points must be a non-empty array", {
      code: "QDRANT_NO_POINTS",
    });
  }
  const normalized = points.map((p, i) => {
    if (p == null || typeof p !== "object") {
      throw new AdapterError(`point[${i}] must be an object`, {
        code: "QDRANT_BAD_POINT",
      });
    }
    if (p.id === undefined || p.id === null) {
      throw new AdapterError(`point[${i}] missing id`, { code: "QDRANT_BAD_POINT" });
    }
    if (!Array.isArray(p.vector)) {
      throw new AdapterError(`point[${i}] missing numeric vector array`, {
        code: "QDRANT_BAD_POINT",
      });
    }
    const out = { id: p.id, vector: p.vector };
    if (p.payload !== undefined) out.payload = p.payload;
    return out;
  });
  return { points: normalized };
}

/** Body for POST /collections/{name}/points/search. */
export function buildSearchBody(vector, { limit = 10, filter, withPayload = true, scoreThreshold } = {}) {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new AdapterError("search vector must be a non-empty array", {
      code: "QDRANT_BAD_SEARCH_VECTOR",
    });
  }
  const body = { vector, limit, with_payload: withPayload };
  if (filter !== undefined) body.filter = filter;
  if (scoreThreshold !== undefined) body.score_threshold = scoreThreshold;
  return body;
}

/** Normalize Qdrant search result envelope -> array of {id, score, payload}. */
export function parseSearchResult(json) {
  if (json == null || typeof json !== "object") {
    throw new QdrantHttpError("Malformed Qdrant search response", undefined, json);
  }
  const result = json.result;
  if (!Array.isArray(result)) {
    throw new QdrantHttpError("Qdrant search response missing `result` array", undefined, json);
  }
  return result.map((r) => ({ id: r.id, score: r.score, payload: r.payload ?? null }));
}

// ---- network ops -----------------------------------------------------------

async function request(baseUrl, method, path, body, opts = {}) {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = { "content-type": "application/json", ...(opts.headers ?? {}) };
  if (opts.apiKey) headers["api-key"] = opts.apiKey;

  let res;
  try {
    res = await doFetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (cause) {
    throw new AdapterError(`Qdrant request failed: ${cause.message}`, {
      code: "QDRANT_NETWORK",
      cause,
    });
  }

  let text;
  let json;
  try {
    text = await res.text();
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new QdrantHttpError(`Qdrant non-JSON response (status ${res.status})`, res.status, text);
  }
  if (!res.ok) {
    const detail = json?.status?.error ?? json?.status ?? text;
    throw new QdrantHttpError(`Qdrant HTTP ${res.status}: ${detail}`, res.status, json);
  }
  return json;
}

/**
 * Create the collection if it does not already exist. Idempotent: a 409/"already
 * exists" is treated as success.
 */
export async function ensureCollection(name, vectorSize, distance = "Cosine", opts = {}) {
  if (!name) throw new AdapterError("collection name required", { code: "QDRANT_NO_NAME" });
  const body = buildCreateCollectionBody(vectorSize, distance);
  if (fixtureModeOn()) {
    return opts.fixture ?? { result: true, status: "ok", _fixture: true, _body: body };
  }
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  try {
    return await request(baseUrl, "PUT", `/collections/${encodeURIComponent(name)}`, body, opts);
  } catch (err) {
    if (err instanceof QdrantHttpError && err.status === 409) {
      return { result: true, status: "exists" };
    }
    throw err;
  }
}

/** Upsert points. Returns the Qdrant operation envelope. */
export async function upsertPoints(name, points, opts = {}) {
  if (!name) throw new AdapterError("collection name required", { code: "QDRANT_NO_NAME" });
  const body = buildUpsertBody(points);
  if (fixtureModeOn()) {
    return opts.fixture ?? { result: { status: "completed" }, status: "ok", _fixture: true };
  }
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const wait = opts.wait === false ? "false" : "true";
  return request(
    baseUrl,
    "PUT",
    `/collections/${encodeURIComponent(name)}/points?wait=${wait}`,
    body,
    opts
  );
}

/** Vector search. Returns normalized [{id, score, payload}]. */
export async function search(name, vector, searchOpts = {}, opts = {}) {
  if (!name) throw new AdapterError("collection name required", { code: "QDRANT_NO_NAME" });
  const body = buildSearchBody(vector, searchOpts);
  if (fixtureModeOn()) {
    if (opts.fixture === undefined) {
      throw new AdapterError("fixture mode on but no opts.fixture provided", {
        code: "QDRANT_NO_FIXTURE",
      });
    }
    return parseSearchResult(opts.fixture);
  }
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const json = await request(
    baseUrl,
    "POST",
    `/collections/${encodeURIComponent(name)}/points/search`,
    body,
    opts
  );
  return parseSearchResult(json);
}

export default {
  DEFAULT_BASE_URL,
  ensureCollection,
  upsertPoints,
  search,
  buildCreateCollectionBody,
  buildUpsertBody,
  buildSearchBody,
  parseSearchResult,
  QdrantHttpError,
};
