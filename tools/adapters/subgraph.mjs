// W4 — GraphQL subgraph query adapter.
//
// Plain `fetch` POST against a graph-node GraphQL endpoint. No graphql client
// library. Exposes pure helpers (buildRequestBody / parseResponse) that are
// unit-tested with fixtures, plus `query()` which performs the network call.
//
// Depends (softly) on ./base.mjs for typed errors + fixture plumbing; falls
// back to a local shim if base.mjs is not present yet (sibling owns it).

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

// Use the shared base AdapterError when present; otherwise the fallback. Both
// accept (message, {code, status, cause, details}); base ignores code/status in
// its constructor, so we always also set them on the instance below.
const BaseAdapterError = base?.AdapterError ?? FallbackAdapterError;

export class AdapterError extends BaseAdapterError {
  constructor(message, opts = {}) {
    super(message, opts);
    if (opts.code) this.code = opts.code;
    if (opts.status != null) this.status = opts.status;
  }
}

// Typed error subclasses so callers can branch on failure mode.
export class SubgraphHttpError extends AdapterError {
  constructor(message, status, body) {
    super(message, { code: "SUBGRAPH_HTTP", status });
    this.name = "SubgraphHttpError";
    this.body = body;
  }
}
export class SubgraphGraphQLError extends AdapterError {
  constructor(message, errors) {
    super(message, { code: "SUBGRAPH_GRAPHQL" });
    this.name = "SubgraphGraphQLError";
    this.errors = errors;
  }
}

// base.mjs has no module-level fixture flag (it's per-HttpClient), so this
// adapter keys fixture mode off an env var plus per-call opts.fixture.
function fixtureModeOn() {
  return process.env.ADAPTER_FIXTURE_MODE === "1";
}

/**
 * Build the JSON body for a GraphQL POST request.
 * Pure — no I/O. Unit-tested directly with fixtures.
 */
export function buildRequestBody(queryString, variables = {}, operationName) {
  if (typeof queryString !== "string" || queryString.trim() === "") {
    throw new AdapterError("queryString must be a non-empty string", {
      code: "SUBGRAPH_BAD_QUERY",
    });
  }
  const body = { query: queryString };
  if (variables && Object.keys(variables).length > 0) body.variables = variables;
  if (operationName) body.operationName = operationName;
  return body;
}

/**
 * Parse a GraphQL HTTP JSON response into `data`, throwing typed errors.
 * Pure — accepts the already-decoded JSON object. Unit-tested with fixtures.
 */
export function parseResponse(json) {
  if (json == null || typeof json !== "object") {
    throw new SubgraphGraphQLError("Malformed GraphQL response (not an object)", []);
  }
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const msg = json.errors.map((e) => e?.message ?? String(e)).join("; ");
    throw new SubgraphGraphQLError(`GraphQL errors: ${msg}`, json.errors);
  }
  if (!("data" in json)) {
    throw new SubgraphGraphQLError("GraphQL response missing `data`", []);
  }
  return json.data;
}

/**
 * Execute a GraphQL query against `endpoint`.
 *
 * In fixture mode, returns `opts.fixture` (the decoded response) parsed through
 * parseResponse — no network call.
 *
 * @param {string} endpoint  graph-node GraphQL URL
 * @param {string} queryString
 * @param {object} [variables]
 * @param {object} [opts]  { operationName, headers, fetchImpl, fixture, signal }
 */
export async function query(endpoint, queryString, variables = {}, opts = {}) {
  const body = buildRequestBody(queryString, variables, opts.operationName);

  if (fixtureModeOn() || opts.fixture !== undefined) {
    if (opts.fixture === undefined) {
      throw new AdapterError("fixture mode on but no opts.fixture provided", {
        code: "SUBGRAPH_NO_FIXTURE",
      });
    }
    return parseResponse(opts.fixture);
  }

  if (typeof endpoint !== "string" || !/^https?:\/\//.test(endpoint)) {
    throw new AdapterError("endpoint must be an http(s) URL", {
      code: "SUBGRAPH_BAD_ENDPOINT",
    });
  }

  const doFetch = opts.fetchImpl ?? fetch;
  let res;
  try {
    res = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (cause) {
    throw new AdapterError(`Subgraph request failed: ${cause.message}`, {
      code: "SUBGRAPH_NETWORK",
      cause,
    });
  }

  let json;
  let text;
  try {
    text = await res.text();
    json = text ? JSON.parse(text) : null;
  } catch (cause) {
    throw new SubgraphHttpError(
      `Subgraph returned non-JSON (status ${res.status})`,
      res.status,
      text
    );
  }

  if (!res.ok) {
    // GraphQL servers sometimes return errors in the body with a non-2xx code.
    const gqlErrors = Array.isArray(json?.errors) ? json.errors : undefined;
    throw new SubgraphHttpError(
      `Subgraph HTTP ${res.status}` +
        (gqlErrors ? `: ${gqlErrors.map((e) => e.message).join("; ")}` : ""),
      res.status,
      json ?? text
    );
  }

  return parseResponse(json);
}

export default { query, buildRequestBody, parseResponse, SubgraphHttpError, SubgraphGraphQLError };
