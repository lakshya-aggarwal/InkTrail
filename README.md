# InkTrail

InkTrail is a local-first reader for translated web novels. Its completed
foundation provides a multi-novel library, SQLite persistence, append-only
translation revisions, a versioned HTTP API, and an accessible reader shell.
Source import, translation consistency, durable background work, and EPUB
snapshots are complete. The next migration boundary begins with a read-only
legacy snapshot preflight.

The product is being rebuilt as a multi-novel application. The legacy reader
remains separate and unchanged during migration.

## Documentation

- [Product design](docs/specs/2026-10-11-inktrail-multi-novel-design.md)
- [Architecture overview](docs/architecture/overview.md)
- [SQLite decision](docs/decisions/0001-sqlite-and-in-process-jobs.md)
- [Legacy migration inventory](docs/migration/legacy-reader-inventory.md)
- [Roadmap](docs/roadmap/roadmap.md)
- [Public-release readiness](docs/release/public-release-readiness.md)
- [Design review](docs/reviews/2026-10-11-design-spec-self-review.md)
- [Foundation review](docs/reviews/2026-10-11-foundation-review.md)
- [Kujiang source-adapter decision](docs/decisions/0002-first-source-adapter-kujiang.md)
- [Source-resolution review](docs/reviews/2026-10-12-source-resolution-review.md)

The completed product slices are validated with `pnpm test`, `pnpm exec
playwright test`, `pnpm exec redocly lint openapi/inktrail.v1.yaml`, and the
recorded persistence checks. The Redocly command uses its executable name,
correcting the plan's scoped package-name spelling.

## Run locally

`pnpm start` listens on `http://127.0.0.1:4277` by default, leaving the legacy
WebNovels app on `4177` untouched. Set `PORT` to use another valid port, for
example `PORT=4278 pnpm start`.

## Back up and restore local data

Stop InkTrail before backing up. `pnpm backup:data /path/to/data
/path/to/new-backup` makes a checksum-verified copy of the entire data
directory, including SQLite and EPUB exports. The backup destination must not
already exist.

`pnpm restore:data /path/to/backup /path/to/new-data` verifies every backup
file and restores it only into a new path. It never overwrites an existing data
directory, so the original remains available until the restored copy has been
checked. Start against it with `INKTRAIL_DATA_DIR=/path/to/new-data pnpm start`.
If a backup or restore command is forcibly terminated, confirm it is no longer
running before removing its adjacent `.inktrail-lock` file and retrying.

## Inspect a legacy snapshot

`pnpm inspect:legacy /path/to/WebNovels` reads the four legacy JSON files and
prints a JSON report. It never writes to the legacy directory or InkTrail's
SQLite database. The report groups recognized NovelPing and Kujiang identities,
counts source-faithful cached chapter candidates, and reports duplicate links,
missing cache rows, and global memory that needs explicit novel assignment
before a later import.

## Reconcile a legacy Kujiang catalog

`pnpm reconcile:legacy /path/to/WebNovels https://www.kujiang.com/book/9`
fetches that book's public catalog and prints a read-only manifest. It matches
legacy state rows only by exact canonical Kujiang chapter URL, preserves the
catalog's ordinal order, and reports cache health separately. Redirect standard
output to a reviewed file if it will be used by a future importer. This command
does not write either application and does not prove a relationship to a
NovelPing book.

## Import a reviewed legacy manifest

`pnpm import:legacy /path/to/inktrail.sqlite /path/to/WebNovels manifest.json "Novel title"`
imports only a `provenanceReady` Kujiang manifest. It validates every selected
legacy cache row before one SQLite transaction creates anything, then creates or
reuses the Kujiang-source novel, preserves catalog chapter order, and records
the cached English text as an immutable historical revision. Re-running the
same manifest is safe; a later manifest can append newly reconciled chapters.
The command never changes the legacy directory and never treats a Kujiang book
as evidence that it belongs to a NovelPing work.
