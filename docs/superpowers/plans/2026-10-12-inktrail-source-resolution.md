# InkTrail Source Resolution And Chapter Extraction Plan

> **Execution:** Use sequential subagent-driven development with an independent
> review gate after every task. Work only in
> `/Users/lakshya/Documents/Books/InkTrail/.worktrees/inktrail-source-resolution`
> on branch `codex/inktrail-source-resolution`. This branch starts at the
> reviewed reader foundation commit `605418a` and remains separate from PR #1.

## Goal

Make one original Chinese chapter import trustworthy, durable, and usable by
the future translation pipeline. A user can submit a supported Kujiang chapter
URL for an existing InkTrail novel. InkTrail validates and fetches the page,
extracts its Chinese chapter content, records source provenance, and makes the
new chapter visible to the existing reader without altering translation
history.

## Non-Goals

- Do not resolve a NovelPing or WTR-LAB URL to Chinese source pages.
- Do not walk previous or next links, bulk import a novel, or start a queue.
- Do not invoke Ollama, create a translation revision, add consistency memory,
  export EPUB, or import legacy cache data.
- Do not add a general web crawler, a plugin system, user credentials, or
  arbitrary URL fetching.
- Do not change the foundation reader layout. A source-workspace UI belongs to
  a later source-discovery or jobs slice.

## Architecture Decisions

### Source Scope

The first adapter is `kujiang`. It accepts only canonical chapter URLs of the
form `https://www.kujiang.com/book/<book-id>/<chapter-id>`. The adapter is
registered through a minimal adapter registry, even though there is initially
one adapter. This prevents Kujiang parsing rules from leaking into routes or
repositories and gives Qmkan its future home without inventing a plugin
framework.

The import endpoint processes exactly one user-provided chapter. Previous and
next source URLs may be stored as provenance metadata but are never fetched in
this slice.

### Durable Provenance

Migration `002-sources.sql` creates the two source tables promised by the
approved design:

```sql
create table novel_sources (
  id text primary key,
  novel_id text not null references novels(id) on delete restrict,
  site text not null,
  external_novel_id text not null,
  source_url text not null,
  normalized_url text not null,
  title text,
  selected_at text not null,
  created_at text not null,
  unique (novel_id, site, external_novel_id),
  unique (site, normalized_url)
);

create table chapter_sources (
  id text primary key,
  novel_id text not null references novels(id) on delete restrict,
  chapter_id text not null references chapters(id) on delete restrict,
  novel_source_id text not null references novel_sources(id) on delete restrict,
  site text not null,
  external_chapter_id text not null,
  source_url text not null,
  normalized_url text not null,
  source_title text not null,
  previous_source_url text,
  next_source_url text,
  fetched_at text not null,
  content_sha256 text not null,
  created_at text not null,
  unique (chapter_id, site),
  unique (site, external_chapter_id)
);
```

`chapter_sources.novel_id` is intentionally explicit even though it can be
derived through `chapter_id`. It makes novel isolation inspectable and allows
the repository to reject a cross-novel mapping before inserting it. The source
tables preserve fetched provenance; `chapters.original_text` remains the
reader's current original text field.

Repeated import of the same canonical source is idempotent. It returns the
existing matching mapping if the extracted content hash matches. A changed hash
or a mapping that belongs to another novel returns a stable conflict rather
than silently replacing source content. Later source-refresh work can introduce
an append-only source snapshot model deliberately.

### Parsing And Fetch Safety

The adapter has pure functions for URL normalization and HTML extraction. The
parser returns:

```js
{
  site: 'kujiang',
  externalNovelId: '9',
  externalChapterId: '906595',
  sourceUrl: 'https://www.kujiang.com/book/9/906595',
  normalizedUrl: 'https://www.kujiang.com/book/9/906595',
  title: '...',
  paragraphs: ['Chinese paragraph 1', 'Chinese paragraph 2'],
  previousSourceUrl: null,
  nextSourceUrl: null
}
```

It extracts the bounded chapter-content container, converts paragraph and line
break elements into paragraph boundaries, decodes common entities, strips
markup, rejects navigation and boilerplate, and requires at least one Chinese
paragraph. Parsing must not use broad regular expressions that can mistake page
chrome for prose. Fixture assertions verify every returned field.

Network fetching is an adapter service responsibility, not a parser concern.
It must validate the URL before fetch and after every redirect, require HTTPS
and `www.kujiang.com`, set a short timeout, cap the response body, request HTML,
and map timeout, bad status, oversize, and malformed content to a typed
retryable `SourceFetchError`. The client is injected for tests.

### Import Transaction

`SourceImportService.importChapter({ novelId, sourceUrl })` owns the flow:

1. Confirm the InkTrail novel exists.
2. Choose an adapter using the normalized URL or reject it as unsupported.
3. Fetch and parse the source chapter.
4. Use an explicit database transaction to create/select the novel source,
   record a new chapter using a deterministic source-derived chapter order, and
   create the source mapping.
5. Return the reader chapter representation plus its source metadata.

Kujiang's external chapter IDs are site ordering identifiers, not story chapter
numbers. The initial import endpoint therefore requires `chapterNumber` in its
request body. The imported record uses that reader ordering number, while the
source tables retain Kujiang's independent external identifiers. Discovery and
title-based numbering are future resolver responsibilities.

The request body is:

```json
{
  "sourceUrl": "https://www.kujiang.com/book/9/906595",
  "chapterNumber": 2491
}
```

The operation is atomic: a fetch or parse failure changes nothing. A duplicate
reader chapter number, duplicate source mapped to another chapter, source mapped
to a different novel, or content-hash mismatch returns `409` without replacing
the existing chapter, source mapping, or translation revision.

### HTTP Contract

Add:

```text
POST /api/v1/novels/{novelId}/source-chapters
```

The route accepts JSON only and reuses existing malformed JSON and error shape
handling. It returns `201` on a new import and `200` when an identical source
mapping is already present. Error mapping:

| Situation | Status | Error code | Retryable |
| --- | --- | --- | --- |
| malformed or unsupported source URL | 400 | `validation_error` | false |
| missing novel | 404 | `not_found` | false |
| duplicate or inconsistent mapping | 409 | `conflict` | false |
| Kujiang fetch/timeout/non-2xx/oversize | 502 | `source_fetch_failed` | true |
| unexpected failure | 500 | `internal_error` | true |

Update OpenAPI and the local Postman collection with a successful fixture-style
request and each stable failure category. Do not publish any collection to a
cloud workspace.

## Tasks

### Task 1: Add Source Provenance Migration And Repository Tests

**Files:**

- Create `src/db/migrations/002-sources.sql`
- Create `src/sources/source-repository.js`
- Modify `test/db/migrate.test.js`
- Create `test/sources/source-repository.test.js`

1. Write failing migration tests for both source tables, foreign keys, unique
   site/external identities, and novel isolation.
2. Add migration `002` and confirm the existing versioned runner applies it
   once, serially, and atomically.
3. Implement a source repository that creates/selects novel sources, creates
   chapter mappings, queries a mapping by canonical source URL, and never
   returns rows from another novel.
4. Test identical mappings, cross-novel collisions, content-hash conflicts,
   and camelCase records.
5. Run focused SQLite and repository tests. Commit:
   `feat: persist source provenance`.

### Task 2: Implement The Fixture-Backed Kujiang Adapter

**Files:**

- Create `src/sources/kujiang-adapter.js`
- Create `src/sources/adapter-registry.js`
- Create `test/fixtures/kujiang/chapter.html`
- Create `test/sources/kujiang-adapter.test.js`

1. Add a real saved HTML fixture with Chinese content, title, body, navigation
   attributes, and unrelated page chrome. It must contain no user session data.
2. Write failing tests for canonical and rejected URLs, extraction boundaries,
   entity/markup cleanup, Chinese paragraph detection, title, external IDs,
   and navigation URLs.
3. Implement pure parsing and a one-adapter registry.
4. Add fetch behavior through an injected client, covering timeout, invalid
   redirect target, non-OK status, body limit, and parse failure with typed
   retryable errors.
5. Run source tests. Commit: `feat: add Kujiang source adapter`.

### Task 3: Add Atomic Source Import Service

**Files:**

- Create `src/sources/source-import-service.js`
- Modify `src/domain/errors.js`
- Modify `src/app.js`
- Create `test/sources/source-import-service.test.js`

1. Write failing service tests using a fake fetch client and the fixture parser.
2. Implement source import with a single SQLite transaction around source
   provenance and chapter creation. Validate `novelId`, `sourceUrl`, and the
   positive reader `chapterNumber` before any fetch.
3. Assert new import, idempotent re-import, chapter-number conflict,
   cross-novel source conflict, changed content conflict, and no database state
   after fetch/parse failure.
4. Compose the service in `createApp` with a production fetch client.
5. Run focused service, migration, and existing repository tests. Commit:
   `feat: import sourced chapters atomically`.

### Task 4: Publish And Test The Source-Chapter API Contract

**Files:**

- Modify `src/http/router.js`
- Modify `src/services/library-service.js`
- Modify `openapi/inktrail.v1.yaml`
- Modify `postman/InkTrail Foundation.postman_collection.json`
- Modify `test/http/app.test.js`

1. Add failing HTTP tests for successful import, idempotent re-import, JSON
   media handling, missing novel, unsupported URL, source conflict, and
   retryable source fetch errors. Use an injected fixture fetch client, never
   a live page.
2. Expose the endpoint through the existing service and stable JSON error
   shape. The route must not reveal raw upstream response bodies.
3. Document the endpoint and all error responses in OpenAPI and mirror the
   requests in the local Postman collection.
4. Run focused HTTP tests, `pnpm test`,
   `pnpm exec playwright test`, and
   `pnpm exec redocly lint openapi/inktrail.v1.yaml`.
5. Commit: `feat: add source chapter import API`.

### Task 5: Review, Document, And Prepare The Translation Boundary

**Files:**

- Create `docs/reviews/2026-10-12-source-resolution-review.md`
- Modify `README.md`
- Modify `docs/roadmap/roadmap.md`

1. Run all test and contract commands on the branch, including a restart test
   proving source mappings and imported Chinese chapters survive restart.
2. Confirm the reader can retrieve the imported source chapter with no
   translation revision and display its source provenance only through the API,
   not as fabricated English text.
3. Record exact commands, fixtures, scope, source-fetch policy, known limits,
   and the next translation-and-consistency plan boundary.
4. Update the roadmap to mark only source import complete. Commit:
   `docs: record source import validation`.

## Validation Matrix

| Risk | Owner | Evidence |
| --- | --- | --- |
| Migration corrupts existing library | Task 1 | Existing and source migration tests, idempotency check |
| Source mapping leaks across novels | Tasks 1 and 3 | Cross-novel repository and service tests |
| Parser treats navigation chrome as prose | Task 2 | Fixture field and paragraph assertions |
| Arbitrary URL SSRF or unsafe redirect | Task 2 | URL, redirect, timeout, body-limit tests |
| Failed fetch leaves partial source state | Task 3 | Transaction rollback tests |
| API replaces a chapter or revision | Task 4 | Duplicate/conflict HTTP tests |
| Reader shows invented translation | Task 5 | Reader/API source-only assertion |
| Contract drifts from implementation | Task 4 | OpenAPI lint and local Postman parity |

## Plan Self-Review

- The plan stays within the approved first follow-on boundary: source tables,
  one fixture-backed adapter, and persisted discovered chapter content.
- The initial adapter is intentionally user-directed and single-chapter. It
  avoids the future jobs subsystem while still exposing an end-to-end import.
- Existing reader ordering remains explicit. No assumption equates a Kujiang
  external ID to a story chapter number.
- All external parsing behavior is deterministic under fixtures. Live smoke
  testing is deferred until the adapter's documented fetch policy and test
  suite are in place.
