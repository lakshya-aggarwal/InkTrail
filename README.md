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

## Inspect a legacy snapshot

`pnpm inspect:legacy /path/to/WebNovels` reads the four legacy JSON files and
prints a JSON report. It never writes to the legacy directory or InkTrail's
SQLite database. The report groups recognized NovelPing and Kujiang identities,
counts source-faithful cached chapter candidates, and reports duplicate links,
missing cache rows, and global memory that needs explicit novel assignment
before a later import.
