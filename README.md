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

## Install

InkTrail is currently a local, single-user application. It stores its SQLite
database and EPUB exports on your machine, and the desktop command is a
development wrapper rather than a public installer.

### Prerequisites

- [Node.js](https://nodejs.org/) 24.19 or newer, plus `pnpm`.
- Git.
- For translation: [Ollama](https://ollama.com/) with the local `qwen3:30b`
  model.
- For the optional desktop wrapper: stable Rust and the system dependencies
  listed in the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

Clone the repository and install its locked dependencies:

```sh
git clone https://github.com/lakshya-aggarwal/InkTrail.git
cd InkTrail
corepack enable
pnpm install --frozen-lockfile
```

If Corepack is unavailable in your Node installation, install `pnpm` using its
[official installation guide](https://pnpm.io/installation), then run the same
`pnpm install --frozen-lockfile` command.

For translations, download the supported model once:

```sh
ollama pull qwen3:30b
```

Run `ollama serve` in a separate terminal when Ollama is not already running.
Reading, source import, and local library management do not require Ollama;
queued translations do.

## Get started

### 1. Start the reader

For browser-based development:

```sh
pnpm start
```

Open [http://127.0.0.1:4277](http://127.0.0.1:4277). InkTrail uses this port
by default and leaves the legacy WebNovels app on `4177` untouched. Set `PORT`
to use another valid port, for example `PORT=4278 pnpm start`.

For the native development wrapper, after installing the desktop prerequisites:

```sh
pnpm desktop:dev
```

This stages the local runtime, starts InkTrail on an ephemeral loopback port,
and opens the reader in a native window. See [the desktop wrapper architecture](docs/architecture/desktop-wrapper.md)
for the runtime and release boundary.

### 2. Add a novel and source chapters

1. In **Your shelf**, enter a title and select **Create novel**.
2. Select the novel, then choose one supported source workflow:
   - Paste a NovelPing chapter URL into **NovelPing chapter URL**, select
     **Resolve**, then select **Import source chapters** after a verified match.
   - Paste a canonical Kujiang book URL into **Add Kujiang source**, select
     **Discover source**, then select **Import source chapters**.
3. Wait for the background import to finish. InkTrail preserves the source
   chapter order and allows safe retries after transient fetch failures.

### 3. Translate, read, and export

1. Set the desired chapter range and choose an installed model from **Ollama
   model** under **Continue this novel**, then select **Queue translation**.
   InkTrail records the chosen model with that job and its revisions instead
   of overwriting prior translations, and checks for common quality and
   consistency issues.
2. Read with the previous and next controls or your arrow keys. Select
   **Report a translation issue** to suggest a context-aware correction.
3. Select **Create EPUB** when translated chapters are available, then use the
   displayed download link. The export is an immutable snapshot, so later
   translations can continue without changing an already downloaded EPUB.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `pnpm start` | Run the local browser reader. |
| `pnpm desktop:dev` | Stage and run the Tauri development wrapper. |
| `pnpm test` | Run the Node test suite. |
| `pnpm test:e2e` | Run the Playwright reader checks. |
| `pnpm backup:data <data-dir> <backup-dir>` | Create a verified local backup. |
| `pnpm restore:data <backup-dir> <new-data-dir>` | Restore into a new directory without overwriting existing data. |

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
