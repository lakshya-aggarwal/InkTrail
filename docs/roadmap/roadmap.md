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

## Kujiang Catalog Import

Complete. A reader can explicitly submit a canonical Kujiang book URL, persist
a bounded ordered catalog separately from content, and run a resumable
source-only import job. The reader workspace exposes deliberate discovery,
import, progress, pause/resume, and stale-navigation-safe controls. See [ADR
0005](../decisions/0005-kujiang-catalog-and-durable-source-import.md) and the
[implementation plan](../superpowers/plans/2026-10-17-inktrail-kujiang-source-catalog.md).

## Direct Source Import

Complete. The reader exposes the existing guarded one-chapter source import
flow for both empty and active novels. It intentionally stays adapter-neutral:
the current URL policy remains Kujiang-only, while later reviewed adapters can
use the same control without changing reader behavior.

## Legacy Snapshot Preflight

Complete. `pnpm inspect:legacy <legacy-state-directory>` reads the legacy JSON
snapshot without writing to either application. It reports recognized
NovelPing-to-Kujiang novel groups, cache and source-text eligibility, migration
blockers, and global memory requiring an explicit novel assignment. The future
writer will use this report as its approval boundary.

## Legacy Catalog Reconciliation

Complete. `pnpm reconcile:legacy <legacy-state-directory> <kujiang-book-url>`
uses the vetted Kujiang catalog adapter to produce a read-only, ordered source
manifest for exact cached chapter URLs. It deliberately establishes only
Kujiang-source provenance and exposes cache health separately from identity
conflicts. No importer or cross-site ownership inference is included.

## Legacy Catalog Import

Complete. `pnpm import:legacy <database-path> <legacy-state-directory>
<manifest-path> <novel-title>` consumes only a reviewed, source-only manifest.
It verifies cache completeness before a single transaction creates an ordered
Kujiang-source novel, source provenance, and historical translation revisions.
It is idempotent for matching sources and can append new reconciled ordinals,
but fails closed on conflicting content or chapter placement.

## Local Data Backup And Restore

Complete. `pnpm backup:data` creates a checksum-verified copy of the complete
local data directory, including SQLite and EPUB exports. `pnpm restore:data`
validates that copy and restores only to a new directory, preserving the
original library as a rollback path. The remaining private-alpha work is to
surface this workflow from a packaged desktop application.

## Later Boundaries

1. Additional adapters and legacy import: migrate source sites one at a time
   with a current, fixture-backed parser boundary, then build the opt-in,
   read-only JSON importer with duplicate review reporting.

2. Additional resolver providers: add site-specific source-catalog adapters
   only after fixture-backed evidence and safety review.

## Deferred

Cloud sync, multi-user accounts, remote workers, credential automation, a
browser extension, and third-party adapter plugins remain deferred.
