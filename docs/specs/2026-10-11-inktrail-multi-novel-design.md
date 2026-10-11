# InkTrail Multi-Novel Design

## Status

Approved conversational design. This document is the review gate before the
implementation plan is written.

## Purpose

InkTrail is a local-first reader for Chinese web novels that gives readers a
quiet, comfortable reading experience while doing serious translation work in
the background. It replaces the legacy single-novel JSON-state reader with a
clean, multi-novel architecture that supports concurrent requests without
mixing novel data, translations, jobs, or terminology.

## Success Criteria

- A reader can add and resume multiple novels independently.
- Chinese source text is resolved and translated into readable English with
  chapter ordering, source provenance, and translation revisions preserved.
- Character names, gender, sect roles, relationship terms, and cultivation
  levels remain consistent within each novel.
- A reader can report a translation issue, have it reviewed, and retain an
  approved correction as scoped novel memory.
- Background source discovery, translation, prefetch, and EPUB export survive
  a process restart and are visible in the interface.
- A partial EPUB download never interrupts translation. Later chapters are
  appended in their proper ascending positions in subsequent exports.
- The legacy application remains untouched throughout migration.

## Non-Goals

- Multi-user accounts, sync, or shared libraries.
- Distributed workers or cloud job infrastructure.
- Automated login, paywall circumvention, or bypassing source-site limits.
- A general-purpose source-adapter marketplace.
- Automatic migration of legacy caches without reviewable provenance.

## Product Surfaces

### Library

The library is the default home. It shows each novel's title, cover, last-read
chapter, translation readiness, and active work without turning the reading
experience into an operations dashboard.

### Reader

The reader is a centered, typography-first chapter view. It includes previous
and next controls at the top and bottom, left and right arrow-key navigation,
and scroll reset when moving to another chapter. A small consistency note can
explain a relevant translation decision without interrupting the prose. A
reader can report an issue from the chapter.

### Novel Workspace

Each novel has its own chapter list, source mappings, translation state,
glossary and narrative memory, feedback history, active jobs, and EPUB
exports.

### Work Dashboard

The dashboard shows queued, running, retrying, paused, failed, and completed
work for every novel. It explains the affected source, chapter, attempt count,
and next action when work needs attention.

## Architecture

InkTrail is a local Node application with a SQLite core and one in-process job
runner. The database is the durable source of truth. The web layer reads and
writes through domain services rather than knowing source-site or translation
details.

```text
Web UI
  -> API and domain services
    -> SQLite repositories
    -> job runner -> source adapters -> translation provider -> EPUB builder
```

The initial repository layout is:

```text
src/
  db/             migrations and repositories
  novels/         library, metadata, chapter ordering, reading progress
  sources/        URL detection, source resolution, extraction adapters
  translation/    provider contract, quality checks, revision storage
  memory/         glossary, narrative facts, feedback verification
  jobs/           queue claim, retry, pause, recovery, events
  epub/           deterministic export generation
  web/            HTTP routes and reader interface
test/             unit, integration, and end-to-end coverage
data/             ignored local database and EPUB files
```

## Source And Translation Flow

1. A user submits a supported novel or chapter URL.
2. A source adapter normalizes the URL and inspects the novel.
3. The resolver records candidate Chinese sources with confidence and evidence.
4. The chosen adapter discovers chapters and fetches original Chinese text.
5. The translator receives the source text, the relevant novel memory, and a
   concise preceding context window.
6. The quality layer checks for untranslated Chinese, repeated text, malformed
   paragraphs, and source-segment gaps. Failed checks request a focused repair
   translation.
7. The chapter, translation revision, quality findings, and memory changes are
   committed together.

The initial provider is local Ollama using `qwen3:30b`. The provider boundary
allows a future paid provider without changing reader, storage, or job code.

If original Chinese cannot be resolved, InkTrail can retain cleaned English as
an explicitly labelled fallback. It never presents an English rewrite as a
source-faithful retranslation.

## Consistency Memory And Feedback

Memory is scoped to a novel. A memory entry contains the source term, preferred
rendering, semantic scope, supporting evidence, confidence, and status. Scope
allows a correction such as `junior brother` for a sect relationship without
changing ordinary uses of `younger`.

A reader feedback report records the selected text, nearby source and English
context, proposed correction, and reason. Verification may approve, reject, or
request review. Approved feedback creates or updates a scoped memory entry and
can trigger a new translation revision; it never edits prior text in place.

## Durable Job Model

Top-level jobs represent intent such as continuous translation or EPUB export.
They create small, idempotent stages for source resolution, discovery, fetching,
translation, checking, memory updates, and export updates.

Jobs are `queued`, `running`, `retrying`, `paused`, `failed`, or `completed`.
An attempt is persisted before external work begins. Fetch failures wait 15
seconds and allow four total attempts. After the fourth failure, the affected
run pauses with the source, chapter, and failure reason visible to the reader.

Only one translation runs for a novel at a time to preserve narrative order and
memory coherence. A configurable global concurrency limit permits other novels
to progress. Work for an identical chapter and stage deduplicates. On restart,
the runner resumes from committed checkpoints rather than repeating completed
chapters.

After a chapter opens, a low-priority read-ahead job keeps the next two chapters
ready. Advancing to the next chapter refills that window. A full-novel run may
continue independently.

## SQLite Model

| Area | Records | Responsibility |
| --- | --- | --- |
| Library | `novels`, `reading_progress` | Novel identity, metadata, and last read position |
| Sources | `novel_sources`, `chapter_sources` | Supported URLs, source provenance, and mappings |
| Content | `chapters`, `translations` | Ordered Chinese text and append-only English revisions |
| Memory | `memory_entries`, `feedback_reports` | Glossary, narrative facts, and verified corrections |
| Work | `jobs`, `job_attempts`, `job_events` | Queue state, retries, recovery, and dashboard activity |
| Export | `epub_exports` | Chapter range, translation provenance, local file, checksum |

Key constraints:

- Chapters are unique by `(novel_id, chapter_number)`.
- A source mapping is unique by source site and external chapter identity.
- Translation revisions are append-only, with one current revision per chapter.
- All mutable records carry a novel identity. No global cache or glossary is
  shared by default.
- A URL update creates or resumes missing work and never removes prior
  chapters, translations, feedback, or exports.
- EPUB files live under ignored local data storage. SQLite stores their
  provenance and availability rather than binary content.
- Versioned SQL migrations define all schema changes.

## API Contract Direction

The local HTTP API is resource-oriented and versioned before implementation.
The implementation plan will create an OpenAPI document and a Postman
collection from this contract before routes are written.

| Resource | Responsibility |
| --- | --- |
| `/api/v1/novels` | Create, list, inspect, and update novel metadata and sources |
| `/api/v1/novels/{novelId}/chapters` | List ordered chapter availability and retrieve a reader chapter |
| `/api/v1/chapters/{chapterId}/feedback` | Submit and inspect translation feedback |
| `/api/v1/novels/{novelId}/memory` | Inspect verified glossary and consistency memory |
| `/api/v1/jobs` | Create and list durable work |
| `/api/v1/jobs/{jobId}` | Inspect, pause, resume, or cancel a job |
| `/api/v1/novels/{novelId}/exports` | Start, inspect, and download EPUB export snapshots |

Mutating requests use idempotency keys where duplicate browser requests could
otherwise create duplicate work. Errors use a stable shape with a machine code,
human message, retryability flag, and relevant resource identifiers.

## Migration

InkTrail is a new repository at `https://github.com/lakshya-aggarwal/InkTrail`.
The legacy application is not refactored in place. Reusable behavior moves in
small, tested modules only:

- Source parsing and URL normalization for NovelPing, Kujiang, Qmkan, and
  WTR-LAB.
- Translation prompt and structured response concepts.
- EPUB packaging behavior.
- Consistency checks, feedback ideas, and reader interaction lessons.

The legacy global JSON files, single active EPUB job, generated caches,
single-novel defaults, oversized server structure, and screenshots do not move.

An opt-in later importer may read legacy JSON files and write valid content into
a new InkTrail SQLite database. It is read-only against the legacy application,
preserves provenance, and reports duplicates or conflicts for review.

## Validation

- Unit tests cover repositories, migrations, adapters, ordering, translation
  checks, memory scope, retries, job transitions, and EPUB ordering.
- Integration tests use a clean database and controlled source and Ollama
  responses to validate independent concurrent novels and restart recovery.
- End-to-end tests cover adding a novel, reading with keyboard navigation,
  feedback correction, partial EPUB download, and ongoing export updates.
- Desktop and mobile screenshot checks validate the approved reader hierarchy,
  readable text, and non-overlapping controls.
- Short, rate-limited live-source smoke tests validate each supported adapter.

## Phased Rollout

1. Documentation-only repository baseline and migration inventory.
2. SQLite core, migrations, library, and approved reader shell.
3. One Chinese source adapter and local Ollama translation path.
4. Durable jobs, memory, feedback, and read-ahead.
5. Resumable EPUB exports and legacy importer.
6. Remaining source adapters, each with fixtures and smoke coverage.

## Deferred Roadmap

Multi-user sync, remote workers, cloud libraries, a browser extension,
credential automation, and broad third-party adapter plugins remain explicitly
out of scope until the local multi-novel experience is stable.
