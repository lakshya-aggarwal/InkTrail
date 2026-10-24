# Legacy Catalog Reconciliation Review

## Scope

This delivery adds a read-only CLI and pure manifest builder for legacy cache
rows that can be matched exactly to a current Kujiang catalog. It does not add
an importer, database write path, HTTP route, or reader UI.

## Safety Boundary

- The catalog is fetched through the existing Kujiang adapter, which validates
  canonical URLs and ascending catalog entries.
- A manifest includes only catalog ordinal, canonical source URL, and source
  title. It excludes cached Chinese and English chapter prose.
- Duplicate, foreign-book, and catalog-missing source URLs make
  `provenanceReady` false.
- Missing or incomplete historical cache is reported as re-fetch work, rather
  than being treated as a provenance failure.
- A Kujiang manifest never proves NovelPing ownership. Any later import needs
  an explicit user choice of the destination novel.

## Validation Results

Completed on 2026-10-24:

```sh
node --test test/migration/legacy-snapshot.test.js test/migration/legacy-catalog-reconciliation.test.js
node --test test/**/*.test.js
git diff --check
```

The targeted suite passed 8 tests. The complete backend suite passed 197 tests.
The CLI also rejects an unreadable local snapshot before it reaches the source
catalog fetch. `git diff --check` passed.

The targeted tests cover ordered exact matches, cache-text exclusion, duplicate
legacy source rows, source URLs absent from the authoritative catalog, and an
unrelated Kujiang book that must not block the selected book. An independent
re-review found the original multi-book blocker, verified its repair, and
returned `REVIEW CLEAN`.
