# Legacy Reader Migration Inventory

## Source Application

`/Users/lakshya/Documents/Books/WebNovels` is the legacy single-novel reader.
It remains operational and is not modified by InkTrail migration work.

## Reusable Behavior

- Source-specific extraction for NovelPing, Kujiang, Qmkan, and WTR-LAB.
- URL recognition, normalization, and chapter traversal.
- Chinese source resolution heuristics and confidence handling.
- Ollama translation prompt construction and response validation.
- Detection and repair of Chinese fragments in English translations.
- Feedback verification and scoped terminology corrections.
- EPUB assembly and ordered chapter export.
- Reader requirements: arrow-key navigation, top and bottom chapter controls,
  scroll reset, and next-two-chapter prefetch.

## Intentionally Excluded

- Global JSON state files and cache layout.
- A single global source map, glossary, translation cache, or EPUB job.
- Generated runtime exports and screenshots.
- Direct migration of the large legacy server module.
- Hardcoded Return of the War God defaults.

## Migration Method

Each reusable behavior will be reimplemented behind an InkTrail boundary and
covered by focused tests. Legacy code is reference material, not a dependency.
The first supported source adapter is migrated before the other adapters, then
additional sources follow with their own fixtures and smoke checks.

## Legacy Data Import

A later importer reads legacy state without changing it. It validates chapter
identity and order, retains source provenance, imports translations as
historical revisions, and produces a review report for duplicates or conflicts.

## Snapshot Preflight

The first migration delivery is a read-only preflight command:

```sh
pnpm inspect:legacy /path/to/WebNovels
```

It reads only `source-map.json`, `translation-state.json`,
`translation-cache.json`, and `consistency-memory.json`. It prints aggregate
counts only - never chapter source text or translated prose - and does not open
or modify InkTrail's database.

The report derives a novel identity only from known legacy URL shapes:
NovelPing chapter URLs identify a NovelPing book, and Kujiang chapter URLs
identify a Kujiang book. It counts complete cached Chinese source segments and
English translations separately, but treats a cache row as importable only when
its exact canonical Kujiang chapter URL is mapped to the selected NovelPing
book. A shared Kujiang book URL is not sufficient provenance. Invalid links,
missing cache records, duplicate source mappings, orphan navigation links,
unassigned cache rows, and global terminology memory are reported as blockers
rather than guessed through.
