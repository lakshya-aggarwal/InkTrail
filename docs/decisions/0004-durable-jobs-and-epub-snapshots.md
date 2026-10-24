# ADR 0004: Durable Jobs And EPUB Snapshots

## Status

Accepted on 2026-10-14.

## Context

InkTrail can import one supported Chinese source chapter at a time and append
translation revisions. Direct translation is synchronous, so it cannot provide
restart recovery, bounded concurrent work, retry visibility, or a stable EPUB
artifact while translation continues.

The current source adapters do not discover an entire novel. This slice must
not imply that they do. Durable translation work therefore begins only from
chapters already persisted with `chapter_sources` provenance.

## Decision

- Add SQLite-backed `jobs`, `job_attempts`, and `job_events` records. A job is
  novel-scoped intent; attempts and events are immutable operational history.
- Support `translate_chapters` and `build_epub` jobs only. A translation job
  accepts an explicit ordered chapter range or explicit chapter numbers, then
  selects only already-imported sourced chapters in ascending
  `chapter_number` order. It neither fetches nor discovers source chapters.
- A job state is one of `queued`, `running`, `retrying`, `paused`, `failed`,
  or `completed`. Allowed transitions are:
  `queued -> running|paused`, `running -> retrying|paused|failed|completed`,
  `retrying -> queued|paused`, and `paused -> queued`. Terminal `failed` and
  `completed` states never transition. Cancellation is not part of this slice.
- Persist an attempt before external work starts. Retryable failures schedule
  the same unit for 15 seconds later. Four total attempts are permitted;
  failure of the fourth attempt pauses the job with its chapter, attempt, and
  sanitized reason recorded. Resume creates a new queued attempt cycle for the
  paused unit without deleting history.
- Claim runnable jobs transactionally. The in-process runner uses a fixed
  global concurrency limit and permits at most one `translate_chapters` job
  performing a translation for a given novel. Jobs for distinct novels may
  run concurrently.
- On startup, expire stale running claims, append a recovery event, and return
  affected jobs to `queued` or `retrying` based on their durable next-run time.
  Completed chapter checkpoints and prior attempts remain untouched.
- Deduplicate work by novel, job type, and normalized ordered target. An
  idempotency key returns the existing compatible job. A conflicting active
  target returns a conflict rather than creating overlapping translation work.
- Build an EPUB as a snapshot. It records, per included chapter, the exact
  latest translation revision selected at snapshot creation, chapter number,
  title, and source provenance. Later translations or feedback revisions do
  not alter an existing export; a new export creates a new snapshot.
- Store EPUB files below one ignored, application-owned export directory. The
  database stores only a generated relative filename, byte size, checksum, and
  availability state. File names derive from export identifiers, never user
  titles or URLs. Write to a temporary file in that directory, fsync/close it,
  then atomically rename it into place. Download handlers resolve and verify
  that the stored relative path stays under the export root.

## Consequences

- A reader can pause, resume, and inspect local work without losing completed
  translations or export history after restart.
- The first EPUB capability is intentionally a snapshot of already translated,
  contiguous or explicit chapter selections. It does not make a partial source
  mapping look like full-novel coverage.
- Implementation must expose stable job and export resources through the
  existing versioned local HTTP API, update OpenAPI and Postman artifacts, and
  keep raw provider or filesystem details out of responses.
- Worker-process distribution, source discovery, cancellation, retention
  pruning, and cloud export storage remain future concerns.
