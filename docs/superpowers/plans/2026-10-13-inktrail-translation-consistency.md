# InkTrail Translation And Consistency Plan

**Goal:** Add local Chinese-to-English translation revisions, quality checks,
verified per-novel memory, and reader feedback without introducing the durable
job runner.

**Non-goals:** source crawling, additional source adapters, background queues,
prefetch, EPUB export, remote providers, cloud credentials, and global memory.

## Task 1: Translation Quality, Memory, And Feedback Storage

Add an additive migration and repositories for per-revision quality findings,
per-novel verified memory entries, and feedback reports. Test novel isolation,
append-only history, status transitions, and migration safety.

## Task 2: Ollama Provider And Quality Checker

Define the injected provider contract and local Ollama `qwen3:30b` adapter.
Build fixture-backed prompt/context shaping and pure checks for Chinese leakage,
duplicate prose, malformed paragraphs, and source-segment gaps. No live Ollama
call belongs in automated tests.

## Task 3: Translation And Feedback Services

Compose chapter lookup, relevant verified memory, provider output, quality
findings, and append-only revisions atomically. Add focused feedback
verification that either rejects, requests review, or approves a correction and
adds a new revision plus scoped memory. Preserve all prior revisions.

## Task 4: Local API Contract

Expose direct translation, feedback, and novel memory operations. Update
OpenAPI and the local Postman collection. Use stable error envelopes and never
return provider prompts, model internals, or raw upstream responses.

## Task 5: Reader Feedback And Validation

Show the latest English revision in the reader, retain Chinese when no revision
exists, and provide a restrained issue-report action. Validate desktop and
mobile reader flows, API behavior, migration/restart persistence, OpenAPI, and
fixture-driven provider behavior.

## Validation Matrix

- Unit: migrations, repositories, memory scope, feedback transitions, quality
  checks, provider request/response handling.
- Integration: append-only translation revision plus quality findings and
  approved feedback update in one transaction; independent novels remain
  isolated.
- HTTP: direct translation, feedback, and memory contracts and typed failures.
- Browser: reader English rendering, Chinese fallback, feedback flow, desktop
  and mobile screenshots with no overlapping controls.
- Commands: `pnpm test`, `pnpm exec playwright test`,
  `pnpm exec redocly lint openapi/inktrail.v1.yaml`, and `git diff --check`.
