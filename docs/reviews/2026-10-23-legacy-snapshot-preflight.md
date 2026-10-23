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
`translation`, which can preserve source-faithful chapters without a mandatory
re-fetch only when the exact cached Kujiang chapter URL is also mapped to the
selected legacy NovelPing book.

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

A subsequent range-planning check found a fifth provenance flaw: the first
version associated every cached chapter in a Kujiang book with a NovelPing book
that happened to map to the same Kujiang book. The preflight now requires an
exact canonical chapter URL mapping. This changes unproven cache rows into
visible `unassigned_translation_row` blockers.

## Verification

- Focused preflight tests: 5 passing after the provenance repair.
- The corrected real legacy snapshot has one recognized novel group with 317
  explicit mappings but no exact cached chapter matches. It reports two orphan
  navigation links, 2,793 unassigned translation rows, 3,006 unreferenced cache
  entries, and global memory requiring assignment.
- Full backend suite: 194 passing after the provenance repair.
- Final independent re-review: `REVIEW CLEAN`.
