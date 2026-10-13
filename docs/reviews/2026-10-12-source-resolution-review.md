# Source Resolution Review - 2026-10-12

## Status

Complete. The source-resolution slice adds durable novel and chapter
provenance, one fixture-backed Kujiang chapter importer, and the local
source-chapter API. It does not begin translation.

## Validation Evidence

Run these commands from the repository root with the declared Node `v24.19.0`
runtime available on `PATH`:

```text
pnpm exec node --test test/http/app.test.js
pnpm test
pnpm exec playwright test
pnpm exec redocly lint openapi/inktrail.v1.yaml
```

The recorded completion run passed the full Node suite: 44 tests passed, 0
failed. Its Playwright suite passed 8 tests across desktop Chromium at
1440x1000 and mobile Chromium at 390x844. Redocly validated
`openapi/inktrail.v1.yaml` with three existing recommended-rule warnings:
missing `info.license`, and missing 4XX responses for `getHealth` and
`listNovels`.

The HTTP and restart exercise used the saved
`test/fixtures/kujiang/chapter.html` fixture through injected fetch only. It
created a novel and imported `https://www.kujiang.com/book/9/906595` at reader
chapter 2491, closed the app, reopened the same SQLite file, and verified all
of the following through HTTP:

- `GET /api/v1/novels/{novelId}/chapters/2491` returned the imported Chinese
  `originalText`, `translatedText: null`, and `revision: null`.
- Repeating `POST /api/v1/novels/{novelId}/source-chapters` returned 200 with
  the original persisted chapter-source ID.
- The import response carried the source mapping; the reader UI rendered the
  Chinese text and did not render the Kujiang URL or invented English text.

Reader screenshots and accessibility snapshots are retained with the task
evidence:

- `.superpowers/sdd/2026-10-12-inktrail-source-resolution/task-5-artifacts/task-5-source-reader-desktop.png`
- `.superpowers/sdd/2026-10-12-inktrail-source-resolution/task-5-artifacts/task-5-source-reader-mobile.png`

The live visual check found no overflow or clipping at either viewport. The
only console message was the existing reader-foundation `GET /favicon.ico` 404;
it is outside this source-resolution slice and was not changed.

## Source Fetch Policy

The only adapter accepts canonical HTTPS `www.kujiang.com/book/<book>/<chapter>`
URLs. It validates the initial URL and every redirect, applies a short timeout,
caps HTML response size, and turns timeout, redirect, response-status,
body-limit, and malformed-content failures into retryable source-fetch errors.
The parser is deterministic against the saved fixture and is not a crawler.

## Scope And Limits

This slice imports one user-directed chapter only. It does not resolve
NovelPing or WTR-LAB URLs, follow previous or next links, fetch in batches,
perform a live-source smoke test, invoke a translation provider, append a
translation revision, create consistency memory, run jobs, or alter the reader
layout. Kujiang external chapter IDs remain provenance identifiers, while the
caller supplies the reader chapter number.

## Next Boundary

Chinese translation and consistency may add provider, quality, feedback, and
memory modules only by appending `translation_revisions`. It must preserve the
reader's source-text fallback and provenance isolation established here.
