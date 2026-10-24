# Kujiang Source Catalog Plan Review - 2026-10-17

## Status

Approved for implementation planning.

## Scope Check

The plan adds one explicit Kujiang book-catalog and source-only import path.
It keeps catalog metadata separate from fetched chapter content, preserves the
existing imported-source boundary for translation and EPUB, and reuses durable
job lifecycle rules only after defining catalog-entry checkpoints.

## Risks Addressed

- A catalog cannot silently create reader chapters or trigger background work.
- Retry, pause, and recovery retain the exact catalog entry rather than
  guessing from navigation links or chapter numbers.
- Ownership, source identity, and claim-token rules are extended at SQLite
  boundaries before runner work.
- Fixture-only parsing and the existing strict HTTPS fetch policy avoid making
  this slice a general crawler.

## Deferred

NovelPing resolution, other adapters, automatic crawling, translation, and
live-source validation remain intentionally outside this plan.
