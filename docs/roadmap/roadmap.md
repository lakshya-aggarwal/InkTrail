# Roadmap

## Foundation

Complete. The documentation baseline, SQLite migrations, local data boundaries,
API contract, persistence checks, and approved reader shell passed the recorded
unit, browser, and OpenAPI commands on 2026-10-11. The Redocly command is
`pnpm exec redocly lint openapi/inktrail.v1.yaml`, correcting the plan's
package-name spelling to its executable name. See the [foundation
review](../reviews/2026-10-11-foundation-review.md).

## Source Resolution And Chapter Import

Complete. One user-directed Kujiang chapter URL can be fixture-validated,
fetched under a narrow HTTPS policy, parsed into Chinese source text, and
persisted with novel and chapter provenance. The endpoint is atomic and
idempotent, and the reader preserves source Chinese text when no translation
revision exists. See the [source-resolution
review](../reviews/2026-10-12-source-resolution-review.md).

## Next Plan Boundaries

1. Chinese translation and consistency: add provider, quality, feedback, and
   memory modules that append `translation_revisions` rather than altering the
   reader contract.

2. Durable jobs and EPUB: add job and export schema migrations, then connect
   source and translation stages to persisted retries, prefetch, pause/resume,
   recovery, and ordered EPUB snapshots.

3. Additional adapters and legacy import: migrate source sites one at a time and
   build the opt-in, read-only JSON importer with duplicate review reporting.

## Deferred

Cloud sync, multi-user accounts, remote workers, credential automation, a
browser extension, and third-party adapter plugins remain deferred.
