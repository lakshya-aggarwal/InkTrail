# InkTrail Kujiang Source Catalog And Import Plan

## Goal

Let a reader submit one canonical Kujiang book URL, inspect a bounded ordered
catalog, and explicitly run a resumable source-only import. The result is
ordered Chinese chapters with source provenance. No translation is started.

## Existing Boundaries To Preserve

- `kujiang-adapter` currently accepts only canonical chapter URLs and applies
  the source fetch policy. Extend it with a separate book-catalog operation;
  do not loosen chapter URL parsing.
- `source-import-service` atomically persists a chapter and `chapter_sources`.
  Reuse that transaction per catalog entry rather than duplicating provenance
  writes.
- `translate_chapters` still accepts only imported sourced chapters. EPUB
  snapshots remain revision-backed and never treat a catalog as imported text.
- Durable jobs already supply leases, events, pause/resume, recovery, and
  four-attempt 15-second retries. Add only catalog-entry-aware behavior needed
  for the new type.

## Data Model And Migration

1. Add migration `010-kujiang-source-catalogs.sql`.
2. Add `source_catalogs`: `id`, `novel_id`, `novel_source_id`, `site`,
   `canonical_book_url`, `content_sha256`, `entry_count`, `created_at`.
   Require the source and novel to agree; unique active identity is
   `(novel_source_id, content_sha256)`.
3. Add `source_catalog_entries`: `id`, `catalog_id`, `novel_id`, `ordinal`,
   `external_chapter_id`, `source_url`, `normalized_url`, `source_title`, and
   `created_at`. Require catalog/novel ownership, unique `(catalog_id, ordinal)`,
   unique `(catalog_id, normalized_url)`, and increasing positive ordinals.
4. Evolve `jobs.type` to include `source_import_catalog`; its `target_json`
   contains only `catalogId`. Add `current_catalog_entry_id` rather than
   overloading `current_chapter_id`. Extend `job_attempts` with nullable
   `catalog_entry_id`, requiring exactly one compatible checkpoint by job type.
5. Add migration triggers for novel ownership, target membership, and job-type
   checkpoint shape. Upgrade validation must reject inconsistent existing rows
   before recording the schema version.
6. Extend job/event serialization with the catalog-entry identifier only where
   a source-import event needs it. Preserve existing public resources.

## Adapter And Catalog Service

1. Add `canonicalizeKujiangBookUrl()` and `fetchCatalog()` beside the current
   chapter parser. Reject non-HTTPS URLs, credentials, ports, query/fragment
   variants, unsupported hosts, redirects outside the supported canonical
   namespace, non-HTML responses, oversized documents, missing catalog
   structure, duplicate chapter URLs, and non-monotonic source order.
2. Parse only the saved catalog container and canonical chapter anchors. Strip
   markup to titles, retain external IDs from canonical URLs, and cap the
   catalog at a documented safe maximum. Treat cap overflow as a non-retryable
   validation failure, not partial discovery.
3. Add a catalog repository and service. Fetch and validate the whole catalog
   before its single database transaction. Return an equivalent existing
   snapshot idempotently; otherwise append a new immutable snapshot. Never
   delete prior snapshots or imported chapters.
4. Bind a novel source to the canonical book URL transactionally. A URL already
   owned by another novel is a conflict. A different book URL for the same
   novel requires an explicit future source-selection flow, not replacement.

## Durable Source-Import Job

1. Extend `job-repository` target canonicalization, allowed job types, active
   target deduplication, attempts, events, stale recovery, and claim queries
   for `source_import_catalog`. Keep source-import candidates serialized per
   novel and globally limited by the existing runner capacity.
2. Add catalog repository queries for the lowest uncompleted entry in the
   selected snapshot. Completion is a matching imported `chapter_sources`
   mapping plus the durable completion event. The catalog ordinal becomes the
   explicit reader chapter-number policy, rather than inferring a number from
   the URL. Always pick the lowest ordinal.
3. Extend the runner with a small job-type dispatch. For a claimed source import
   job, persist the entry attempt and checkpoint, call the existing
   `sourceImportService.importChapter()` with the entry URL and ordinal, then
   atomically finalize attempt, checkpoint, and event under the claim token.
4. Classify network/timeout/non-HTML/body-limit/upstream-malformed failures as
   retryable source failures. Retry at 15 seconds for attempts 1-3. On attempt
   4, write `paused_after_failure` and pause without advancing the entry.
   Ownership, catalog integrity, and provenance conflicts are stable
   non-retryable failures. Do not expose raw upstream or SQLite details.
5. Ensure a stale or paused worker cannot create a chapter, mapping, attempt,
   event, or next checkpoint after another worker reclaimed the job. Recovery
   abandons only the source-import attempt with the expired claim, then resumes
   at the earliest incomplete catalog entry.

## HTTP Contract

Update OpenAPI and the local Postman collection before route implementation.

| Method and resource | Contract |
| --- | --- |
| `POST /api/v1/novels/{novelId}/source-catalogs` | Validate and fetch one canonical Kujiang book URL, persist or return an equivalent catalog snapshot. `201` or idempotent `200`; `400`, `404`, `409`, or safe retryable `502`. |
| `GET /api/v1/novels/{novelId}/source-catalogs` | List catalog snapshots with canonical URL, entry count, and import progress, newest first. |
| `GET /api/v1/novels/{novelId}/source-catalogs/{catalogId}` | Return bounded ordered metadata only, never fetched chapter bodies. |
| `POST /api/v1/jobs` | Accept `source_import_catalog` with `{ catalogId }`, `novelId`, and optional `Idempotency-Key`; return `201` or the compatible existing job. |

Existing `GET /api/v1/jobs`, job detail, pause, and resume resources expose
the new type and catalog-entry checkpoint with the same safe state envelope.
The old one-chapter `source-chapters` endpoint remains for intentional manual
imports and must not start catalog discovery.

## Reader-First UX

- Novel workspace offers a compact "Add Kujiang source" input and shows the
  resulting catalog count and source URL after deliberate submission.
- "Import source chapters" is an explicit action. It shows a short progress
  line: imported count, current source chapter, retry/pause reason, and
  Pause/Resume controls. It never begins on page load.
- Reader chapter navigation, keyboard controls, and layout remain unchanged.
  Newly imported chapters appear in external catalog order, with Chinese
  source text until a later translation slice acts on them.
- Keep catalog metadata and job detail in the workspace, not over the chapter
  prose. Do not display raw upstream URLs or errors in the reading surface.

## Fixtures And Security Policy

- Add saved static Kujiang book-list fixtures for normal ordering, HTML noise,
  duplicate/invalid links, missing structure, and an over-limit catalog. Keep
  all tests offline with injected `fetch`.
- Retain the existing 5-second timeout, 1 MB body cap, three canonicalized
  redirects, manual redirect handling, and HTML content-type validation. The
  catalog parser must not fetch entry URLs.
- Do not follow scripts, forms, JavaScript pagination, login flows, paywalls,
  or arbitrary URLs. No credentials, cookies, browser automation, or live
  source test is part of this slice.

## Test Matrix

- Adapter: book canonicalization, safe redirects, cap, content type/body
  limits, deterministic ordered parsing, duplicate rejection, and no entry
  fetches.
- Migration/repository: clean and upgrade paths, catalog and entry ownership,
  snapshot idempotency, immutable historical catalog, job/checkpoint shape,
  target deduplication, and cross-novel rejection.
- Runner/service: ordinal imports, already-imported skip, two-novel capacity,
  same-novel serialization, 15-second retries, fourth-attempt pause,
  pause/resume, restart recovery, stale-claim write rejection, and no duplicate
  chapters after an at-least-once external fetch.
- HTTP: safe failure envelopes, idempotency replay/mismatch, catalog ownership,
  explicit start only, job lifecycle, and no translation revision created.
- Browser: catalog submission and explicit import are understandable at desktop
  and mobile sizes; reader remains usable during import; no overflow, focus
  loss, or accidental auto-start.

## Rollout And Completion

1. Land migration and catalog repositories with upgrade tests.
2. Land fixture-backed Kujiang catalog discovery and snapshot service.
3. Land the source-import job schema/runner path with deterministic recovery
   tests.
4. Land API/OpenAPI/Postman composition and lifecycle tests.
5. Land restrained reader workspace controls, then inspect desktop and mobile
   pixels before accepting the slice.

Run `pnpm test`, `pnpm exec playwright test`,
`pnpm exec redocly lint openapi/inktrail.v1.yaml`, and `git diff --check`.

## Explicit Non-Goals

- NovelPing resolver or any resolver heuristics.
- New source adapters.
- Background crawling, read-ahead import, or automatic import after catalog
  discovery.
- Translation, quality checks, consistency memory, feedback, or EPUB changes.
