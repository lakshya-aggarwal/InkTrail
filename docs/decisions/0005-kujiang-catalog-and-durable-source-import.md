# ADR 0005: Persist Kujiang Catalogs Before Durable Source Import

## Status

Accepted - 2026-10-17

## Context

InkTrail can safely import one user-directed canonical Kujiang chapter URL.
Durable jobs deliberately translate only imported source chapters. That keeps
translation provenance correct, but it cannot import a book without asking the
reader to supply every chapter URL and reader chapter number.

A book catalog and fetched chapter content have different lifecycles. The
catalog is bounded source metadata that can be refreshed or inspected without
creating reader chapters. Imported content is durable provenance and must stay
ordered, idempotent, and recoverable after a retry or process restart.

## Decision

Add the smallest separate source-discovery boundary for one canonical
`https://www.kujiang.com/book/<book>` URL:

- The Kujiang adapter accepts only that canonical book URL for discovery and
  returns one bounded, strictly ordered catalog of canonical chapter URLs,
  external chapter IDs, source titles, and source order. It uses the existing
  HTTPS host, timeout, body-size, redirect, and deterministic-parser policy.
- Persist a `source_catalogs` snapshot and `source_catalog_entries` separately
  from `chapters` and `chapter_sources`. A successful catalog snapshot is
  immutable; selecting the same canonical book refreshes by creating a new
  snapshot only when its normalized ordered entries differ.
- A reader explicitly creates a `source_import_catalog` job for a chosen
  complete catalog snapshot. The job imports one catalog entry at a time in
  increasing external catalog order. It uses a dedicated catalog-entry
  checkpoint, never guesses reader chapter numbers from URLs, and records each
  imported chapter at the catalog entry's source order.
- Import uses the existing single-chapter source import transaction after the
  catalog entry has been claimed. An already-provenanced matching chapter is a
  completed checkpoint, not a duplicate. A conflicting chapter or provenance
  mapping fails the job with a stable safe error.
- Retryable fetch or parse failures wait exactly 15 seconds and permit four
  total attempts for the same catalog entry. The fourth failure pauses the
  job. Pause, resume, lease recovery, events, and sanitized errors follow the
  existing durable-job conventions.
- `source_import_catalog` is a new job type, not a broadened
  `translate_chapters` target. Its target is exactly `{ "catalogId": "..." }`.
  The schema must add catalog-entry ownership checks, its own partial active
  per-novel uniqueness, claim and attempt validation, and recovery/runnable
  selection without weakening the existing translation or EPUB invariants.

## Consequences

- Discovery remains user-directed and bounded. Import begins only after the
  reader explicitly starts it; neither creating a novel nor loading a chapter
  starts crawling.
- Catalog entries are source facts, while `chapters` remain the reader's
  numbered content records. This keeps existing translation and EPUB code
  compatible because they continue to require imported `chapter_sources`.
- The reader sees a compact novel-scoped source status and explicit Import
  action, not an operations dashboard. It can continue reading during import.
- NovelPing resolution, any second adapter, automatic background crawling,
  translation, and changes to translation/EPUB semantics are out of scope.
