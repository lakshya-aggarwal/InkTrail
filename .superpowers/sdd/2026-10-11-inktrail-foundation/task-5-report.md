# Task 5 Report

## Status

DONE

The reader implementation, focused browser suite, and requested visual
acceptance are complete. The Task 5 files are committed after Fix Round 1.

## Files Changed

- `public/index.html` - accessible shelf, novel form, reader, and top/bottom navigation.
- `public/app.js` - library creation/loading, query-string reader state, chapter navigation,
  reading-progress persistence, focus management, scroll reset, and guarded arrow keys.
- `public/styles.css` - paper/ink/moss/clay palette, flat controls, desktop shelf beside reader,
  and mobile shelf above reader.
- `src/app.js` - fixed static asset serving for `/`, `/app.js`, and `/styles.css` with content types.
- `test/e2e/reader.spec.js` - library creation plus reader URL, progress, focus, scroll, and input-keyboard tests.
- `docs/architecture/foundation.md` - static-reader boundary and reader URL/focus/scroll behavior.
- `pnpm-workspace.yaml` - resolved the existing `core-js` build-policy placeholder as `false` so the specified pnpm runner can start without approving an unnecessary postinstall script.

## Test Evidence

Pre-implementation reader test failures, after the runner was made runnable:

```text
✘ library creates and displays a novel
  locator.fill: waiting for getByLabel('Novel title')

✘ reader navigation updates chapter, URL, scroll position, focus, and reading progress
  getByRole('heading', { name: 'Chapter 1 title' }) was not found

✘ arrow keys do not navigate while the novel title input has focus
  locator.focus: waiting for getByLabel('Novel title')
```

Passing completed browser command, using the required bundled runtime and a
temporary copy of the Playwright configuration on port `4277`:

```text
PATH="/Users/lakshya/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  /Users/lakshya/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm \
  exec playwright test reader.spec.js \
  --config=/private/tmp/inktrail-task-5.playwright.config.mjs \
  --project=desktop-chromium

3 passed (1.5s)
```

The repository's prescribed configuration could not run in this environment
because port `4177` was already occupied by an unrelated WebNovels process:

```text
Error: Timed out waiting 60000ms from config.webServer.

pw:webserver HTTP GET: http://127.0.0.1:4177/api/v1/health
pw:webserver HTTP Status: 404
```

The unrelated listener was verified as `node server.js` with working directory
`/Users/lakshya/Documents/Books/WebNovels`; it was not stopped.

## Browser And Screenshot Evidence

An accessibility snapshot of the implemented initial screen confirmed labeled
`Your shelf`, `Novel title`, `Create novel`, both labeled chapter navigation
regions, both previous/next controls, and a visible reader heading. It was
captured at the browser's initial 1244px-wide viewport before seeding and the
requested resize was interrupted.

The completed viewport evidence appears in Fix Round 1 below.

## Accessibility Behavior

- The novel-title field has a visible label.
- Navigation buttons expose `Previous chapter` and `Next chapter` accessible names.
- Reader navigation uses event delegation for both navigation regions.
- Successful chapter navigation updates the URL, persists reading progress,
  focuses the `h1`, and calls `window.scrollTo(0, 0)`.
- Arrow navigation ignores input, textarea, select, and content-editable targets.
- Keyboard focus uses a restrained clay outline for buttons, the title field,
  and the focused chapter heading.

## Scope And Concerns

No Task 4 route, repository, service, migration, translation, job, adapter, or
EPUB contract was changed. The implementation uses only the requested browser
assets, `src/app.js`, reader E2E test, architecture note, and the necessary
pnpm build-policy metadata correction.

The standard Playwright command remains environment-blocked whenever an
unrelated process owns port `4177`; the accepted focused run used temporary
port `4277` without changing repository port configuration.

## Fix Round 1 And Acceptance

The first visual pass found that the chapter heading received programmatic
focus after navigation but did not draw a visible focus outline following a
pointer-initiated navigation. `public/styles.css` now applies the clay outline
to `#chapter-title:focus`. The reader test now also selects the last matching
shelf entry so repeated runs against the persistent local test database do not
produce an ambiguous locator.

Screenshots were captured from the seeded long chapter at the exact requested
viewports, outside the worktree so no evidence asset was committed:

- Desktop 1440x1000 top: `/Users/lakshya/Documents/Books/WebNovels/.playwright-mcp/inktrail-task-5-desktop-top.png`
- Desktop 1440x1000 bottom: `/Users/lakshya/Documents/Books/WebNovels/.playwright-mcp/inktrail-task-5-desktop-bottom.png`
- Desktop 1440x1000 after navigation and focus: `/Users/lakshya/Documents/Books/WebNovels/.playwright-mcp/inktrail-task-5-desktop-focus.png`
- Mobile 390x844 top: `/Users/lakshya/Documents/Books/WebNovels/.playwright-mcp/inktrail-task-5-mobile-top.png`
- Mobile 390x844 bottom: `/Users/lakshya/Documents/Books/WebNovels/.playwright-mcp/inktrail-task-5-mobile-bottom.png`
- Mobile 390x844 after navigation and focus: `/Users/lakshya/Documents/Books/WebNovels/.playwright-mcp/inktrail-task-5-mobile-focus.png`

Visual inspection passed at both sizes. The shelf is beside the reader at
1440x1000 and above it at 390x844. Prose stays clear of controls, no horizontal
text overflow was measured (`scrollWidth === clientWidth` at both sizes), and
the bottom previous/next controls are visible and usable after a long chapter.
After chapter navigation, `document.activeElement.id` was `chapter-title`,
`window.scrollY` was `0`, and the visible clay focus outline surrounded the
heading in both desktop and mobile screenshots.

Final focused command, using the required bundled Node and pnpm paths with the
temporary port-4277 configuration:

```text
PATH="/Users/lakshya/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  /Users/lakshya/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm \
  exec playwright test reader.spec.js \
  --config=/private/tmp/inktrail-task-5.playwright.config.mjs \
  --project=desktop-chromium

3 passed (1.3s)
```

`git diff --check` passed with no output.
