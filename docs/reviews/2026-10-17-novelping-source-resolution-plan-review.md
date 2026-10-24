# NovelPing Source Resolution Plan Review - 2026-10-17

## Status

Approved for implementation planning.

## Scope Check

The proposed resolver stops at a persisted, evidence-backed catalog proposal.
It preserves the completed catalog importer as the only path that creates
source chapters, and requires a reader to explicitly start that import.

## Risks Addressed

- Exact chapter-number agreement, threshold, and unique-top-candidate rules
  prevent a title-only match from silently selecting a source.
- Immutable attempts and candidate evidence make collisions and future adapter
  regressions inspectable without retaining upstream content.
- Source ownership stays novel-scoped, while provider parsing remains bounded,
  site-specific, fixture-backed, and isolated from the HTTP and reader layers.
- Stable sanitized errors, retry rules, and strict API payloads preserve the
  existing local contract conventions.

## Deferred

Automatic import, general web search, browser automation, NovelPing crawling,
translation behavior, additional broad provider support, and live-site checks
remain intentionally outside the plan.
