# Reader Direct Source Import Review

## Scope

This slice makes InkTrail's existing `POST /api/v1/novels/{novelId}/source-chapters`
resource usable from the reader. It does not change the API contract, source
provenance rules, URL policy, adapter registry, or job runner.

## Reader Behavior

- An empty selected novel presents an expanded "Import a Chinese source
  chapter" control with a required source URL and reader chapter number.
- The same control remains available, collapsed, while reading a novel. It
  defaults to the next chapter only at the end of the current reading order;
  otherwise the reader supplies the intended chapter number.
- A successful import refreshes the shelf, records the imported chapter as
  reading progress, and moves the reader to it. The existing source-import
  service remains the only authority for
  source URL support, provenance, idempotency, and conflicts.
- A completed request from a previously selected chapter or novel may save its
  intended source chapter, but cannot navigate or alter the newer reader
  workspace.
- Empty-novel bookmarks render the same setup state without exposing the raw
  `chapter not found` transport detail.

## Deliberate Boundary

The reader control is adapter-neutral, but the supported source policy remains
Kujiang-only. A Qmkan chapter request currently redirects public unauthenticated
fetches to a Cloudflare verification page, so there is no current source
snapshot suitable for a durable parser fixture. Qmkan support remains a later
adapter boundary rather than an unverified URL allow-list entry.

## Validation

Run the focused reader checks:

```sh
PATH=/Users/lakshya/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
/Users/lakshya/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
node_modules/@playwright/test/cli.js test test/e2e/reader.spec.js --grep 'direct source|direct Chinese'
```

The focused suite covers an empty-novel import after a reload and an in-flight
import completion after switching to a different novel, on desktop and mobile.

Live desktop and mobile inspection confirmed that the empty-novel setup state
is readable, the form does not overflow the reader column, and the compact
mobile layout stacks its inputs without overlap.

Final verification passed with 189 backend tests and 72 desktop/mobile browser
tests. Independent review first identified active-reader default and
reading-progress defects; both were repaired with end-of-order, middle-of-order,
stale-response, and reopen regressions. The final re-review was clean.
