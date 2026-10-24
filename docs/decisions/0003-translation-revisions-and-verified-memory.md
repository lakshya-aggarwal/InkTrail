# ADR 0003: Translation Revisions And Verified Memory

## Status

Accepted.

## Context

InkTrail already stores append-only `translation_revisions`, while the approved
design requires local Ollama translation, quality findings, reader feedback,
and consistency memory that never crosses novel boundaries.

## Decision

- Keep `translation_revisions` append-only and make the latest revision the
  reader-visible translation.
- Add only per-novel `memory_entries`, per-revision quality findings, and
  chapter-scoped feedback reports. No global glossary is introduced.
- Use an injected translation-provider contract. The production composition
  targets local Ollama `qwen3:30b`; tests use deterministic fake providers.
- Translation requests include original Chinese, a bounded preceding context,
  and active verified memory. Quality checks flag untranslated Chinese,
  repeated paragraphs, malformed output, and obvious source-segment gaps.
- Feedback remains pending until explicitly verified. Approval appends a new
  translation revision and may create or update a verified, scoped memory
  entry. It never edits an earlier revision in place.
- This slice exposes direct, local translation and feedback operations only.
  Durable queueing, retries, pause/resume, read-ahead, and EPUB work remain
  the following slice.

## Consequences

The reader can explain the latest translation and readers can correct future
work without silently rewriting history. Provider outages remain a typed
service failure rather than a partially persisted revision.
