# InkTrail Durable Jobs And EPUB Plan

**Goal:** Add durable, restart-safe local translation jobs and immutable EPUB
snapshots for already-imported Chinese source chapters, without extending
source discovery.

**Non-goals:** novel or chapter discovery, fetching unimported source URLs,
new source adapters, retries for direct synchronous translation, cancellation,
remote workers, cloud storage, live Ollama tests, legacy-cache import,
publication-grade EPUB styling, and reader/dashboard redesign beyond controls
needed to inspect and operate the new resources.

## Current Boundaries To Preserve

- `createSourceImportService().importChapter()` fetches and atomically records
  one source chapter with `chapter_sources` provenance. A job may only call the
  existing translation service after that provenance exists. It must not call
  a source adapter, follow `nextSourceUrl`, or infer missing chapter numbers.
- `createTranslationService().translateChapter()` reads the sourced chapter,
  prior persisted source context, and verified per-novel memory, then appends
  a revision and findings atomically. Jobs orchestrate this service; they do
  not duplicate its prompt, provider, or persistence behavior.
- `chapters` are ordered by `(novel_id, chapter_number)` and revisions are
  append-only. A job never updates or deletes a source chapter, translation
  revision, feedback report, memory entry, or prior export.
- Existing API errors are stable, sanitized envelopes. Job and export failures
  must report a resource identifier, retryability, and a safe reason without
  exposing provider prompts, raw upstream bodies, absolute filesystem paths,
  or stack traces.

## Job Data Model

Add one additive migration and repositories under `src/jobs/` and `src/epub/`.
All IDs are UUIDs and timestamps use the existing injected clock.

### `jobs`

| Column | Purpose |
| --- | --- |
| `id` | Stable job resource identity. |
| `novel_id` | Required owner. Every child record is novel-scoped through this row. |
| `type` | `translate_chapters` or `build_epub`. |
| `target_json` | Canonical JSON for the normalized requested range or ordered explicit numbers. |
| `target_hash` | SHA-256 of canonical target data for deduplication. |
| `idempotency_key` | Client supplied unique key within a novel and job type. |
| `state` | `queued`, `running`, `retrying`, `paused`, `failed`, or `completed`. |
| `priority` | Small integer for future read-ahead ordering; this slice uses normal priority. |
| `next_run_at` | Earliest retry or recovered run time; null when not scheduled. |
| `claimed_at` / `claim_token` | Durable in-process lease for restart recovery. |
| `current_chapter_id` | Optional checkpoint currently being translated or exported. |
| `last_error_code` / `last_error_message` | Sanitized latest failure context. |
| `created_at` / `updated_at` / `completed_at` | Lifecycle audit. |

Constrain `type` and `state`. Index runnable work by `(state, next_run_at,
priority, created_at)`, novel activity by `(novel_id, type, state)`, and
idempotency by `(novel_id, type, idempotency_key)`. Enforce one active
translation job per novel with a partial unique index over
`type = 'translate_chapters'` and states `queued`, `running`, or `retrying`.

### `job_attempts`

Each unit of external work gets one immutable attempt row before calling the
provider. Store `id`, `job_id`, `novel_id`, `chapter_id`, `attempt_number`,
`state` (`started`, `succeeded`, `retryable_failed`, `paused_after_failure`,
or `abandoned_on_recovery`), `started_at`, `finished_at`, and sanitized error
code/message. Uniqueness of `(job_id, chapter_id, attempt_number)` guarantees
that recovery cannot create a duplicate numbered attempt.

Attempts belong to translation units. `build_epub` creates one attempt with a
null chapter only because archive generation is a single local operation.

### `job_events`

Append a compact, user-safe event for every lifecycle transition and each
checkpoint: `job_created`, `claimed`, `chapter_started`, `chapter_completed`,
`retry_scheduled`, `paused`, `resumed`, `recovered`, `failed`, and `completed`.
Store `id`, `job_id`, `novel_id`, optional `chapter_id`, event type, safe
message, JSON details limited to resource IDs and counts, and `created_at`.
Events are dashboard history, not a second source of truth for state.

## EPUB Data Model And File Boundary

Create `epub_exports` with `id`, `novel_id`, optional `job_id`, `state`
(`queued`, `building`, `available`, `failed`), normalized selection JSON,
`snapshot_at`, generated relative `file_name`, `byte_size`, `sha256`, safe
failure fields, and lifecycle timestamps. Create `epub_export_chapters` with
`export_id`, `chapter_id`, `translation_revision_id`, `chapter_number`,
`title`, `source_url`, and an ordinal. Constrain one row per export ordinal
and chapter, and enforce ascending chapter order in repository validation.

At snapshot creation, list only selected chapters that have both
`chapter_sources` provenance and a latest `translation_revisions` row. The
selection is either a contiguous inclusive chapter-number range or an explicit
strictly ascending unique list. Reject an empty selection, an unsourced
chapter, a missing translation, or a range with a missing number. Resolve the
latest revision once inside the transaction and persist that revision ID.

The EPUB builder reads only `epub_export_chapters` joined to their captured
revision IDs, ordered by ordinal. It cannot query a newer latest revision.
Partial download is allowed only after a successful complete immutable export;
an export request does not interrupt translation and every later request makes
a new snapshot. The binary lives under the application export root, ignored by
Git. Generate to a same-directory temporary file and atomically rename it on
success. On startup, mark `building` exports failed if their generating job is
not recoverable and remove only their tracked temporary file after validating
it is below the export root. Never derive a path from a title, URL, or request
body and never delete a prior available export during a retry.

## State Machine, Retry, And Recovery

Permitted job transitions are:

| From | To | Actor and condition |
| --- | --- | --- |
| `queued` | `running` | Runner transactionally claims a runnable job. |
| `queued` | `paused` | User pauses before it is claimed. |
| `running` | `retrying` | A retryable provider or local export failure occurs before four total attempts. |
| `running` | `paused` | User pause observed at a chapter checkpoint, or fourth attempt fails. |
| `running` | `failed` | A non-retryable validation, provenance, or archive error occurs. |
| `running` | `completed` | Every requested checkpoint succeeds. |
| `retrying` | `queued` | `next_run_at` is due or recovery requeues it. |
| `retrying` | `paused` | User pauses while waiting. |
| `paused` | `queued` | User explicitly resumes. |

`completed` and `failed` are terminal. There is no cancel endpoint in this
slice. A retryable failure gets attempts 1 through 4 total, including the
first call. Attempts 1 through 3 set `next_run_at = now + 15 seconds`; the
fourth writes `paused_after_failure`, leaves the exact chapter checkpoint
unchanged, and pauses the job. Resuming resets no attempt history. It creates
the next legal attempt number for that checkpoint; a later failure immediately
pauses again once four total attempts for the same checkpoint have already
been exhausted. A user can inspect and explicitly requeue only after correcting
the underlying local condition in a future support action.

The runner reads an environment-free constant for global concurrency, initially
`2`, and owns an in-memory wake loop only. It claims at most that many jobs,
but a database partial unique constraint and claim predicate ensure only one
translation is in flight per novel even if a second runner is accidentally
started. Translation checkpoints always choose the lowest selected
`chapter_number` without a completed translation checkpoint. This preserves
preceding-context and verified-memory order. The runner has no fairness claim
beyond picking oldest eligible jobs of equal priority.

At application startup, the runner finds stale `running` claims in one
transaction, marks their started attempts `abandoned_on_recovery`, clears
claims, appends `recovered`, and returns the job to `queued` when it had no
retry schedule or `retrying` when it does. It never marks an unverified
provider call successful. A completed translation revision is the checkpoint:
on recovery, the runner sees the revision and records chapter completion
instead of calling the provider again. EPUB recovery never serves a partial
file; it removes only validated temporary files and rebuilds the same captured
snapshot or marks a non-recoverable local archive failure `failed`.

## Idempotency And Deduplication

Create jobs through a service that validates the novel and canonicalizes the
target before opening its transaction. Canonical range targets use
`{ "startChapterNumber": n, "endChapterNumber": n }`; explicit targets use
strictly ascending unique `chapterNumbers`. Canonical JSON is hashed. The same
idempotency key with the same normalized input returns the original job; reuse
with different normalized input is a conflict. Without a key, an active
matching `(novel_id, type, target_hash)` job returns the active job instead of
adding duplicate work.

The translation job uses the chapter number and source provenance already in
SQLite as its idempotency boundary. A completed checkpoint with a translation
revision is skipped, recorded as an event, and never creates another revision.
An EPUB snapshot is deduplicated only before snapshot capture: an active export
job with the same novel and normalized selection can be returned. Once an
export has captured revision IDs, every successful explicit request creates a
new immutable export record so availability, checksum, and provenance remain
auditable.

## HTTP Resource Contract

Update `openapi/inktrail.v1.yaml`, the local Postman collection, the router,
and HTTP tests before implementing route bodies. Use the current stable error
envelope and `Idempotency-Key` request header on job or export creation.

| Method and resource | Contract |
| --- | --- |
| `POST /api/v1/jobs` | Create or return a `translate_chapters` job. Body contains `novelId`, `type`, and one normalized selection input. Returns `201` or `200` for an idempotent/deduplicated existing job. |
| `GET /api/v1/jobs?novelId=` | List jobs for one novel, newest first, with current state, checkpoint, attempt count, and next run time. |
| `GET /api/v1/jobs/{jobId}` | Return job, ordered attempts, and ordered safe events. |
| `POST /api/v1/jobs/{jobId}/pause` | Pause a queued or retrying job immediately, or request a running checkpoint pause. Returns the persisted state. |
| `POST /api/v1/jobs/{jobId}/resume` | Requeue a paused job. Reject terminal jobs and no-op duplicate resumes safely. |
| `POST /api/v1/novels/{novelId}/exports` | Capture a selected already-translated snapshot and create or return its `build_epub` job. Returns export and job resources. |
| `GET /api/v1/novels/{novelId}/exports` | List immutable export metadata and availability. |
| `GET /api/v1/novels/{novelId}/exports/{exportId}` | Inspect snapshot range, captured revision IDs, state, checksum, and safe failure details. |
| `GET /api/v1/novels/{novelId}/exports/{exportId}/download` | Stream only an `available` export after novel ownership and export-root validation. Return `409` while unavailable and `404` when absent. |

Return `400` for malformed selection or idempotency inputs, `404` for missing
novel/job/export ownership, `409` for illegal transitions, duplicate key
mismatch, missing source/translation coverage, or unavailable download, and
`502` only for retryable translation-provider failure reported by a worker.
Request handlers enqueue or control durable state and wake the runner after a
commit; they never perform translation or archive creation inline.

## Task 1: Schema And Repositories

1. Add migration `007-durable-jobs-and-epub.sql` with the tables, checks,
   foreign keys, partial indexes, and novel-ownership triggers described above.
2. Add job and export repositories with explicit transactional helpers for
   claim, transition, attempt creation/finalization, event append, snapshot
   capture, and export availability recording.
3. Write migration and repository tests for upgrade safety, novel isolation,
   transition rejection, active per-novel translation uniqueness, canonical
   target deduplication, revision capture, and malicious output path rejection.
4. Commit: `feat: add durable job and export storage`.

## Task 2: Runner And Translation Checkpoints

1. Add a small in-process runner under `src/jobs/` with injected clock,
   scheduler/wake primitive, global limit, and explicit start/stop lifecycle.
2. Claim in SQLite before invoking `translationService.translateChapter()`.
   Persist an attempt before the call and mark the chapter checkpoint complete
   only after the existing service transaction returns successfully.
3. Implement the exact retry, pause, resume, stale-claim recovery, and
   per-novel ordering rules above. Keep runner policy out of the provider and
   source adapter modules.
4. Add deterministic fake-clock/provider tests for two-novel concurrency,
   same-novel serialization, 15-second scheduling, four-attempt pause,
   recovery, and no duplicate revision after a completed checkpoint.
5. Commit: `feat: run durable translation jobs`.

## Task 3: EPUB Snapshot Builder

1. Add deterministic EPUB composition under `src/epub/` that receives an
   export snapshot rather than live chapter queries.
2. Create snapshots transactionally before queueing a `build_epub` job. Build
   from captured chapter/revision rows ordered by ordinal.
3. Add a safe local export-root abstraction with generated filenames,
   same-directory temporary writes, atomic rename, checksum, and download
   lookup validation.
4. Add tests for ascending source/revision order, newer revisions not changing
   prior exports, partial or missing coverage rejection, checksum recording,
   temporary-file recovery, and traversal-resistant download lookup.
5. Commit: `feat: build immutable EPUB snapshots`.

## Task 4: HTTP Contract And Application Composition

1. Add resource schemas, examples, lifecycle and error responses to OpenAPI
   before routes; update the local Postman collection to match.
2. Compose repositories, runner, and EPUB builder in `createApp()` and server
   startup/shutdown. Start recovery after migrations, not before.
3. Add router handlers that validate, transact, wake the runner, and return
   resource representations without raw provider, filesystem, or stack data.
4. Add HTTP tests for idempotent job creation, legal and illegal controls,
   owner isolation, retry-safe status reporting, snapshot creation, unavailable
   download, and successful content disposition/download.
5. Commit: `feat: expose durable job and EPUB resources`.

## Task 5: Reader And Workspace Integration

1. Add restrained novel-workspace controls to start translation of a selected
   imported range, observe current job status, pause/resume, create an EPUB
   snapshot, and download an available snapshot.
2. Keep the reader reading-first. Progress is compact and novel-scoped; the
   library/dashboard listing is the operational detail surface.
3. Add browser coverage for progress across reload, pause/resume, a paused
   fourth failure, export availability, and download without interrupting an
   active translation job. Inspect desktop and mobile screenshots for readable
   controls, correct focus order, and no overlap.
4. Commit: `feat: show durable work and EPUB snapshots`.

## Validation Matrix

- Unit: canonical target parsing, state transitions, claimed-job selection,
  active same-novel exclusion, retry arithmetic, event redaction, export path
  containment, and revision snapshot selection.
- Migration/integration: clean and upgrade databases; persisted attempt/event
  history; restart recovery; completed checkpoint skip; two novels advancing
  concurrently without cross-novel data; EPUB immutability after a feedback
  revision.
- HTTP: idempotency-key replay and mismatch, legal/illegal pause/resume,
  novel ownership, retry status, export capture, unavailable and available
  download, and stable error envelopes.
- Browser: normal reader use remains fast while background work runs; status
  is announced accessibly; pause/resume stays correct after reload; export
  controls and download work on desktop and mobile.
- Commands: `pnpm test`, `pnpm exec playwright test`,
  `pnpm exec redocly lint openapi/inktrail.v1.yaml`, and `git diff --check`.

## Completion Criteria

- Every translation job operates only on already-imported sourced chapters and
  preserves ascending chapter order.
- A retryable failure is visible, waits exactly 15 seconds between attempts,
  and pauses after the fourth total failed attempt without deleting evidence.
- Restart recovery is deterministic and cannot append a duplicate revision for
  a completed checkpoint.
- One novel never has simultaneous translation calls, while the configured
  global limit allows independent novels to make progress.
- An available EPUB contains the captured ordered revisions, is immutable,
  downloadable only through a contained local path, and does not stop ongoing
  translation work.
