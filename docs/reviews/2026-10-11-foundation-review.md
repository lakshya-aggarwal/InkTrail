# Foundation Review - 2026-10-11

## Status

Complete. The foundation implementation and its accepted equivalent validation
passed before this completion record was written.

## Validation Evidence

### Complete Test Suite

```text
PATH="/Users/lakshya/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  /Users/lakshya/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm test
```

Result: PASS - 18 tests passed, 0 failed. The test command is scoped to
`test/**/*.test.js`, preventing Node's runner from loading Playwright
`*.spec.js` files. Playwright owns those browser specifications separately.

### Browser Suite

```text
PATH="/Users/lakshya/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  /Users/lakshya/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm \
  exec playwright test --config=/private/tmp/inktrail-task-5.playwright.config.mjs
```

Result: PASS - 8 tests passed across `desktop-chromium` and `mobile-chromium`.
The temporary configuration changes only the test server from port `4177` to
`4277`. Port `4177` remains owned by an unrelated WebNovels process and was not
stopped or reconfigured. The repository Playwright configuration was not
changed.

Task 5 screenshot evidence remains preserved outside this worktree:

- Desktop 1440x1000 top: `/Users/lakshya/Documents/Books/WebNovels/.playwright-mcp/inktrail-task-5-desktop-top.png`
- Desktop 1440x1000 bottom: `/Users/lakshya/Documents/Books/WebNovels/.playwright-mcp/inktrail-task-5-desktop-bottom.png`
- Desktop 1440x1000 after navigation and focus: `/Users/lakshya/Documents/Books/WebNovels/.playwright-mcp/inktrail-task-5-desktop-focus.png`
- Mobile 390x844 top: `/Users/lakshya/Documents/Books/WebNovels/.playwright-mcp/inktrail-task-5-mobile-top.png`
- Mobile 390x844 bottom: `/Users/lakshya/Documents/Books/WebNovels/.playwright-mcp/inktrail-task-5-mobile-bottom.png`
- Mobile 390x844 after navigation and focus: `/Users/lakshya/Documents/Books/WebNovels/.playwright-mcp/inktrail-task-5-mobile-focus.png`

The retained visual review confirms the desktop shelf is beside the reader, the
mobile shelf is above it, prose and controls do not overlap, no horizontal text
overflow occurs, bottom navigation remains visible, and focus is visible after
chapter navigation.

### OpenAPI Contract

```text
/Users/lakshya/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  node_modules/@redocly/cli/bin/cli.js lint openapi/inktrail.v1.yaml
```

Result: PASS - the direct installed Redocly CLI validated the document and
exited 0. With no Redocly configuration file, it used the built-in recommended
rules and reported three non-blocking warnings: missing `info.license`, and a
missing 4XX response for each of `getHealth` and `listNovels`. After validation,
its optional update check attempted to invoke `npm`, which is not on this
environment's path; that message did not affect the successful exit status.

The direct installed CLI is recorded as the accepted equivalent validation so
this review does not depend on pnpm's ignored-build policy behavior.

### Persistence Across Restart

The exercise used one temporary data directory, then started, stopped, and
restarted the production entry point with the same directory:

```text
data_dir=$(mktemp -d /private/tmp/inktrail-restart.XXXXXX)
PATH="/Users/lakshya/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  PORT=4277 INKTRAIL_DATA_DIR="$data_dir" \
  /Users/lakshya/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm start
```

It created a novel and chapters 1 and 2 with `POST /api/v1/novels` and
`POST /api/v1/novels/{novelId}/chapters`, set chapter 2 with
`PATCH /api/v1/novels/{novelId}/reading-progress`, stopped the process, and
repeated the start command against the same `data_dir`. The post-restart GET
requests verified the library, both chapter records, and reading progress.

```text
data_dir=/private/tmp/inktrail-restart.L5KZmA
sqlite_file_count=1
sqlite_files=/private/tmp/inktrail-restart.L5KZmA/inktrail.sqlite
library_novel_count=1
chapter_numbers=1,2
reading_progress=2
```

## Scope And Legacy Repository

This review changes documentation and the test command selection only. It does
not add source adapters, translation providers, consistency memory, durable
jobs, EPUB export, or legacy import behavior.

The legacy repository at `/Users/lakshya/Documents/Books/WebNovels` was
untouched by this foundation work and review. Its existing unrelated working
tree changes and the preserved Task 5 evidence were not modified.

## Follow-On Plan Boundaries

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
