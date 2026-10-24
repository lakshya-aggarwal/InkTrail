# Legacy Catalog Import Review

## Scope

This slice adds a CLI-only, transactional importer for a reviewed legacy
Kujiang catalog manifest. It does not add a public HTTP route, automatic
import, NovelPing ownership inference, or legacy-file writes.

## Data Safety

- `provenanceReady` must be `true` and every manifest entry must be canonical,
  unique, and belong to the stated Kujiang book.
- All selected cache rows are verified before the transaction begins. Missing,
  mismatched, incomplete, or duplicate rows leave InkTrail unchanged.
- One transaction writes the novel, chapters, chapter provenance, and historical
  translation revisions together.
- Existing exact source rows are preserved. New manifest ordinals append to the
  same source novel; content or chapter-order conflicts fail closed.
- The returned CLI result contains only identifiers and counts, not chapter
  prose.

## Validation Results

Completed on 2026-10-24:

```sh
node --test test/migration/legacy-catalog-import-service.test.js test/migration/legacy-catalog-reconciliation.test.js test/migration/legacy-snapshot.test.js
node --test test/**/*.test.js
git diff --check
```

The focused migration suite passed 14 tests, including the full CLI path. The
complete backend suite passed 203 tests and `git diff --check` passed.

Independent review found a canonical-versus-raw source URL P1: a query-string
legacy row could have supplied a cache payload for a canonical manifest chapter.
The importer now requires selected state URLs to be already canonical before it
accepts their cache data. The regression test verifies zero writes for that
case, and the independent re-review returned `REVIEW CLEAN`.
