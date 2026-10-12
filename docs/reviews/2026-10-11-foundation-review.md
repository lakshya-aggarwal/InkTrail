# Foundation Review - 2026-10-11

## Status

Complete. The foundation implementation passed the recorded unit, browser,
OpenAPI, and restart validation before this completion record was updated.

## Validation Evidence

Run the following commands from the repository root:

```text
pnpm test
pnpm exec playwright test
pnpm exec redocly lint openapi/inktrail.v1.yaml
```

Results:

- `pnpm test`: PASS - 18 tests passed, 0 failed. The test command is scoped to
  `test/**/*.test.js`, preventing Node's runner from loading Playwright
  `*.spec.js` files.
- `pnpm exec playwright test`: PASS - 8 tests passed across
  `desktop-chromium` and `mobile-chromium`.
- `pnpm exec redocly lint openapi/inktrail.v1.yaml`: PASS - the document is
  valid. Redocly reports three existing non-blocking recommended-rule warnings:
  missing `info.license`, and a missing 4XX response for `getHealth` and
  `listNovels`.

The Task 6 plan wrote `@redocly/cli`, which is the package name rather than an
installed executable. The command above is the corrected normal invocation:
the installed package exposes `redocly` and `openapi` binaries.

### Browser Suite

The checked-in `playwright.config.js` uses `http://127.0.0.1:4277` for the
browser base URL and health check, and starts the test server with
`PORT=4277 INKTRAIL_DATA_DIR=.test-data node src/server.js`. This is the
configuration used by the passing `pnpm exec playwright test` command. Port
`4177` remains owned by the unrelated WebNovels process and was not stopped or
reconfigured.

Task 5 screenshot evidence remains preserved outside this worktree as earlier
visual-review evidence. It was captured with that task's temporary environment
and is not presented as evidence for the final checked-in Playwright
configuration:

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

### Persistence Across Restart

The following exact sequence starts the production entry point with one fresh
data directory, writes through the HTTP API, restarts it against the same
directory, and verifies the persisted records. It uses `4278` only for this
manual exercise so it does not overlap the browser suite's stable `4277` port.

```sh
set -eu

data_dir=$(mktemp -d /private/tmp/inktrail-restart.XXXXXX)
start_server() {
  PORT=4278 INKTRAIL_DATA_DIR="$data_dir" pnpm start >"$data_dir/server.log" 2>&1 &
  server_pid=$!
  for attempt in $(seq 1 30); do
    if curl --fail --silent http://127.0.0.1:4278/api/v1/health >/dev/null; then
      return
    fi
    sleep 1
  done
  curl --fail --silent http://127.0.0.1:4278/api/v1/health >/dev/null
}

start_server
novel_id=$(curl --fail --silent --show-error --request POST \
  --header 'content-type: application/json' \
  --data '{"title":"Restart evidence novel"}' \
  http://127.0.0.1:4278/api/v1/novels | \
  node -e 'let body = ""; process.stdin.on("data", (chunk) => body += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(body).id));')
curl --fail --silent --show-error --request POST \
  --header 'content-type: application/json' \
  --data '{"chapterNumber":1,"title":"Restart chapter 1","originalText":"One"}' \
  "http://127.0.0.1:4278/api/v1/novels/$novel_id/chapters" >/dev/null
curl --fail --silent --show-error --request POST \
  --header 'content-type: application/json' \
  --data '{"chapterNumber":2,"title":"Restart chapter 2","originalText":"Two"}' \
  "http://127.0.0.1:4278/api/v1/novels/$novel_id/chapters" >/dev/null
curl --fail --silent --show-error --request PATCH \
  --header 'content-type: application/json' \
  --data '{"chapterNumber":2}' \
  "http://127.0.0.1:4278/api/v1/novels/$novel_id/reading-progress" >/dev/null

kill "$server_pid"
wait "$server_pid" || true
start_server

library=$(curl --fail --silent --show-error http://127.0.0.1:4278/api/v1/novels)
novel=$(curl --fail --silent --show-error "http://127.0.0.1:4278/api/v1/novels/$novel_id")
chapter_one=$(curl --fail --silent --show-error "http://127.0.0.1:4278/api/v1/novels/$novel_id/chapters/1")
chapter_two=$(curl --fail --silent --show-error "http://127.0.0.1:4278/api/v1/novels/$novel_id/chapters/2")
node --input-type=module -e 'const [library, novel, first, second] = process.argv.slice(1).map(JSON.parse); if (library.items.length !== 1 || library.items[0].id !== novel.id || novel.readingProgress.chapterNumber !== 2 || first.chapterNumber !== 1 || first.originalText !== "One" || second.chapterNumber !== 2 || second.originalText !== "Two") throw new Error("restart verification failed"); console.log("library_novel_count=" + library.items.length); console.log("chapter_numbers=" + first.chapterNumber + "," + second.chapterNumber); console.log("reading_progress=" + novel.readingProgress.chapterNumber);' "$library" "$novel" "$chapter_one" "$chapter_two"
sqlite_file_count=$(find "$data_dir" -maxdepth 1 -type f -name inktrail.sqlite | wc -l | tr -d ' ')
test "$sqlite_file_count" = 1
printf 'sqlite_file_count=%s\n' "$sqlite_file_count"

kill "$server_pid"
wait "$server_pid" || true
```

Expected results are `library_novel_count=1`, `chapter_numbers=1,2`,
`reading_progress=2`, and `sqlite_file_count=1`. The recorded run produced
those results using `/private/tmp/inktrail-restart.onwYGQ`.

## Scope And Legacy Repository

This review changes documentation and Playwright test configuration only. It
does not add source adapters, translation providers, consistency memory,
durable jobs, EPUB export, or legacy import behavior.

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
