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

## Translation, Consistency, Durable Jobs, And EPUB

Complete. Translation revisions, scoped consistency memory and feedback,
durable retries and recovery, immutable EPUB snapshots, and reader workspace
controls are implemented. Work remains novel-scoped and translation starts only
from imported sourced chapters.

## Next Plan Boundary

Kujiang catalog-backed source import. A reader will explicitly submit a
canonical Kujiang book URL, persist a bounded ordered catalog separately from
content, and start a resumable source-only import job. See [ADR
0005](../decisions/0005-kujiang-catalog-and-durable-source-import.md) and the
[implementation plan](../superpowers/plans/2026-10-17-inktrail-kujiang-source-catalog.md).

## Later Boundaries

1. Additional adapters and legacy import: migrate source sites one at a time and
   build the opt-in, read-only JSON importer with duplicate review reporting.

2. Source resolution: consider NovelPing only after the Kujiang catalog flow is
   proven, with resolver evidence and safety review separate from adapters.

## Deferred

Cloud sync, multi-user accounts, remote workers, credential automation, a
browser extension, and third-party adapter plugins remain deferred.
