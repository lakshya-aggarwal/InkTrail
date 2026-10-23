# Legacy Snapshot Preflight Review

## Scope

This delivery adds a local, opt-in, read-only inspection command for the legacy
reader's JSON state. It intentionally does not add an HTTP endpoint, source
fetch, SQLite write, automatic import, or reader UI control.

## Behavior

- Reads the exact four legacy state files from a directory supplied on the
  command line.
- Derives a novel group only from recognized legacy NovelPing and Kujiang URL
  shapes.
- Joins translation state to cached payloads by cache key and checks whether
  every cached paragraph has both original Chinese and English text.
- Emits aggregate report counts, never the chapter source or translated prose.
- Reports duplicate mappings, broken source-navigation references, unavailable
  cache rows, incomplete source or translation payloads, and global consistency
  memory that requires explicit novel assignment.

## Observed Legacy Shape

The local legacy snapshot contains chapter-level URLs rather than a durable
novel record. Its cached translation paragraphs retain both `source` and
`translation`, allowing a future importer to preserve source-faithful chapters
without a mandatory re-fetch when the preflight marks them complete.

## Acceptance Boundary

The next writer must remain opt-in and transactional. It may create a new or
explicitly selected InkTrail novel only after the reader approves the preflight
group. It must append historical translation revisions, retain legacy source
URLs as provenance, and reject every preflight blocker rather than replacing
existing InkTrail chapters or assigning global memory automatically.

## Review Repairs

Independent review found four issues in the first implementation. The final
preflight now rejects translation rows without a verified NovelPing owner,
requires HTTPS, exact supported hosts, no explicit port, and numeric Kujiang
book and chapter identities, binds each cache key to its exact source URL, and
normalizes compatible source URL variants before duplicate and navigation-link
checks. Focused regressions cover each case.

## Verification

- Focused preflight tests: 4 passing.
- Full backend test suite: 193 passing.
- Real legacy snapshot: one recognized novel group with 2,774 complete cached
  source and historical-revision candidates. It reports two orphan navigation
  links, 213 unreferenced cache entries, and global memory requiring assignment.
- Final independent re-review: `REVIEW CLEAN`.
