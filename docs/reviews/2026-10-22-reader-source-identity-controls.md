# Reader Source Identity Controls Completion

## Scope

The reader workspace now exposes the existing per-novel vetted Kujiang source
identity registry beside the NovelPing resolver. The controls use the existing
strict list, create, and delete resources; no API or persistence behavior was
changed.

## Reader Behavior

- A closed native disclosure keeps source configuration out of the reading path
  until the reader chooses `Add trusted source`.
- The create form accepts the registry's canonical book URL, source title,
  optional title and author aliases, and optional JSON chapter-title aliases.
- Required fields and URL validity use browser-native validation. Chapter alias
  JSON is checked locally before a request is sent.
- Saved identities render their source title, canonical book link, and author
  when available. Removal requires confirmation because registry corrections
  are intentionally delete-and-recreate operations.
- Source identity reads are scoped to the selected novel and use a refresh
  generation guard. A late response from the same workspace cannot replace a
  newer list after a create or delete.
- Workspace-token guards also prevent late create, remove, and refresh work
  from changing a workspace after the reader switches novels.

## Validation

- Focused identity reader flows: 10 passed across desktop and mobile Chromium.
- Full reader suite: 68 passed across desktop and mobile Chromium.
- Full backend suite: 189 passed.
- Desktop and mobile screenshots were inspected with the editor both closed and
  open. The closed state leaves the chapter near the top of the reader; the
  open state keeps every form control within the viewport width.
- Independent read-only re-review: REVIEW CLEAN after native validation,
  same-workspace refresh ordering, delete confirmation, and deterministic race
  coverage were verified.

## Deliberate Boundaries

- There is no identity update endpoint or client-side metadata merge. A vetted
  correction remains an explicit delete followed by a new identity, as defined
  by ADR 0007.
- The reader does not broaden resolver matching or initiate automatic source
  discovery. It only manages the curated identities consumed by the existing
  resolver.
