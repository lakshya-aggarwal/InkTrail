# Roadmap

## Foundation

Complete. The documentation baseline, SQLite migrations, local data boundaries,
API contract, persistence checks, and approved reader shell passed the recorded
unit, browser, and OpenAPI commands on 2026-10-11. The Redocly command is
`pnpm exec redocly lint openapi/inktrail.v1.yaml`, correcting the plan's
package-name spelling to its executable name. See the [foundation
review](../reviews/2026-10-11-foundation-review.md).

## Next Plan Boundaries

1. Source resolution and chapter extraction: add `novel_sources` and
   `chapter_sources`, migrate one adapter with fixture-based parsing, and route
   discovered chapters through `recordChapter`.

2. Chinese translation and consistency: add provider, quality, feedback, and
   memory modules that append `translation_revisions` rather than altering the
   reader contract.

3. Durable jobs and EPUB: add job and export schema migrations, then connect
   source and translation stages to persisted retries, prefetch, pause/resume,
   recovery, and ordered EPUB snapshots.

4. Additional adapters and legacy import: migrate source sites one at a time and
   build the opt-in, read-only JSON importer with duplicate review reporting.

## Deferred

Cloud sync, multi-user accounts, remote workers, credential automation, a
browser extension, and third-party adapter plugins remain deferred.
