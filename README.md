# InkTrail

InkTrail is a local-first reader for translated web novels. Its completed
foundation provides a multi-novel library, SQLite persistence, append-only
translation revisions, a versioned HTTP API, and an accessible reader shell.
Source resolution, translation, background work, and EPUB export begin at the
documented follow-on boundaries.

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

The foundation is complete following `pnpm test`, `pnpm exec playwright test`,
`pnpm exec redocly lint openapi/inktrail.v1.yaml`, and persistence validation.
The Redocly command uses its executable name, correcting the plan's scoped
package-name spelling. The next plan begins with source resolution and chapter
extraction.

## Run locally

`pnpm start` listens on `http://127.0.0.1:4277` by default, leaving the legacy
WebNovels app on `4177` untouched. Set `PORT` to use another valid port, for
example `PORT=4278 pnpm start`.
