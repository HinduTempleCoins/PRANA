# Running a local Gutendex catalog index (DD2-2)

> Generic, public-safe operations note for standing up a **local Gutendex
> catalog index** of the Project Gutenberg corpus. Nothing here is specific to
> any private deployment; it describes only the open-source Gutendex project and
> the public Project Gutenberg catalog.

## What Gutendex is

[Gutendex](https://gutendex.com) is an open-source (MIT) Django + PostgreSQL web
API that serves a JSON view of the **Project Gutenberg** catalog: ~70,000+
public-domain books, searchable by title/author/topic/language, each row listing
the Gutenberg-hosted download formats. The public instance is rate-limited and
best-effort; for any high-volume or offline use you run your **own** copy.

The matching adapter in this repo is `tools/adapters/library/gutendex.mjs`. It
works against the public instance **or** a local one — just pass `baseUrl`:

```js
new GutendexClient({ baseUrl: "http://127.0.0.1:8000" });
```

so nothing downstream changes when you switch from the public API to a local
index.

## Why self-host

- **Rate limits / availability** — the public instance is a courtesy service; a
  local index removes the rate ceiling and the single point of failure.
- **Offline / air-gapped** — the catalog index is small and can live entirely
  on local infrastructure.
- **Custom fields / filters** — you control the schema and can add derived
  columns (e.g. a normalized license/tier tag — see `tier-routing-spec.md`).
- **No content liability** — the index stores **catalog metadata only**, not the
  book bytes. Book files stay on Gutenberg's mirrors; the index points at them.

## How the catalog is sourced

Project Gutenberg publishes its catalog as a machine-readable feed:

- **RDF/XML catalog dump** — `https://www.gutenberg.org/cache/epub/feeds/rdf-files.tar.bz2`
  (one RDF file per book: title, authors, subjects, languages, copyright flag,
  format URLs). This is the canonical source Gutendex itself ingests.
- Project Gutenberg asks that you **mirror, not hammer**: download the catalog
  dump (and any book files) from a mirror, not by crawling the main site. See
  `https://www.gutenberg.org/policy/robot_access.html` and the mirror list at
  `https://www.gutenberg.org/MIRRORS.ALL`.

## Local bring-up (open-source Gutendex)

Gutendex ships a standard Django management flow. The shape is:

1. **Provision Postgres** and a Python env (Django + psycopg).
2. **Clone Gutendex** (the open-source repo) and set the standard env vars it
   documents (`DATABASE_URL`, `DJANGO_SECRET_KEY`, `ALLOWED_HOSTS`, etc.).
   - ⚠️ Read all secrets (DB URL, Django secret key) from the environment. Do
     **not** hardcode them in any committed file. This mirrors the
     `apiKeyFromEnv()` rule the adapters follow.
3. **Migrate**: `python manage.py migrate`.
4. **Ingest the catalog**: run Gutendex's catalog-update management command,
   which fetches the RDF dump from a Gutenberg mirror and populates the books
   table. Re-run it on a schedule (e.g. weekly) to pick up new books.
5. **Serve**: run the Django app behind a normal WSGI/ASGI server. The adapter
   then points `baseUrl` at it.

### Refresh cadence

Project Gutenberg adds books continuously but not at high volume. A **weekly**
catalog refresh is ample; daily is harmless. The refresh is idempotent — it
upserts against the Gutenberg book id, so re-running never duplicates rows.

### Footprint

The catalog index (metadata only) is on the order of low hundreds of MB in
Postgres — trivial. Mirroring the actual **book files** (epub/txt/html) is a
separate, much larger, optional step and is **not** required for the index/API
to work; the adapter returns the Gutenberg format URLs as pointers either way.

## What this index does NOT do

- It does **not** re-host book content by default — it indexes metadata and
  points at Gutenberg-hosted (public-domain) files.
- It does **not** make any copyright determination beyond the `copyright`
  tri-state Gutenberg already publishes. Tiering (HOST / WINDOW / AGGREGATE)
  is the job of the routing layer in `tier-routing-spec.md`.

## Cross-references

- Adapter: `tools/adapters/library/gutendex.mjs` (+ `gutendex.test.mjs`).
- Shared base: `tools/adapters/library/library-base.mjs` → `tools/adapters/base.mjs`.
- Routing: `design/library/tier-routing-spec.md`.
