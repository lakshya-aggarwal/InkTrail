# InkTrail NovelPing Evidence-Backed Source Resolution Plan

## Goal

Given one canonical NovelPing chapter URL, propose exactly one trusted Chinese
source catalog and matching catalog chapter only when persisted evidence passes
a deterministic threshold. The reader must explicitly start the existing
catalog-import job after resolution. No source content is imported by resolving.

## Existing Boundaries To Preserve

- `source_catalogs` and `source_catalog_entries` are immutable trusted-source
  snapshots. `source_import_catalog` alone imports their content in ascending
  order with existing retry, pause, resume, and claim-token rules.
- `novel_sources`, `chapter_sources`, translation revisions, EPUB snapshots,
  and reader navigation remain untouched until the user starts import.
- Adapters already own URL validation, bounded fetches, redirect checks, typed
  source errors, deterministic parsing, and offline fixtures. Do not put
  provider markup or networking in routes, repositories, or the reader.

## Resolution Policy

1. Accept only a canonical NovelPing HTTPS chapter URL. Reject credentials,
   ports, query/fragment variants, unsupported paths, redirect identity drift,
   non-HTML, oversized bodies, and ambiguous/missing chapter metadata.
2. Extract bounded translated-page evidence: canonical URL, normalized novel
   title, optional normalized author, positive chapter number, normalized
   chapter title, extractor version, and evidence hash. Never persist the
   translated chapter body for this workflow.
3. Query registered catalog-discovery adapters with a normalized novel query.
   Each adapter returns bounded candidate source identity, metadata, catalog
   snapshot, and the candidate entry for the exact chapter number. The first
   non-Kujiang adapter must be a separate named adapter with its own URL policy,
   parser, fixtures, and registry entry - no generic provider implementation.
4. Score independent evidence deterministically. Require exact chapter-number
   equality and a chapter-title match after case/punctuation folding plus either
   an adapter-declared alias or deterministic Chinese romanization. Novel title
   and author strengthen confidence when comparable and fail only on a
   definitive alias-based conflict. Do not infer cross-language meaning with
   machine translation. Persist component scores and matched normalized values,
   not opaque model output. Accept only a unique top candidate at or above the
   threshold; ties, collisions, and incomplete evidence fail closed.
5. After acceptance, atomically bind the source identity and immutable catalog
   snapshot to the novel if ownership permits. The UI exposes an explicit
   "Import source chapters" action that creates the existing job. A rejected or
   unresolved attempt creates no source ownership and no job.

The initial matching configuration is versioned and code-owned: exact chapter
number, normalized source title, and a unique score margin are required. Do not
introduce user-tunable thresholds or fuzzy search until fixture evidence shows a
concrete need.

## Data Model And Migration

Add one migration with these novel-scoped, append-only records:

- `source_resolution_attempts`: attempt ID, novel ID, canonical NovelPing URL,
  extracted evidence JSON/hash/version, state (`resolved`, `unresolved`,
  `failed`), stable error code, selected candidate ID nullable, timestamps.
  Deduplicate an equivalent successful or unresolved request by canonical URL,
  evidence hash, and resolver version.
- `source_resolution_candidates`: candidate ID, attempt ID, adapter/site,
  canonical source identity, catalog ID nullable until accepted, normalized
  metadata and declared aliases, exact candidate catalog-entry identity,
  component scores, total score, rank, and decision reason. Require
  candidate/attempt novel ownership.
- `novel_source_resolutions`: accepted resolution ID, novel ID, NovelPing URL,
  attempt ID, novel source ID, catalog ID, catalog entry ID, resolver version,
  accepted evidence hash, and timestamps. Enforce one active accepted source
  identity per novel and global source-identity ownership, with a conflict
  rather than replacement.

Migration validation must reject malformed state, cross-novel references,
missing required accepted references, duplicate active ownership, checkpoint
conflicts, or preexisting rows incompatible with the new constraints before
recording its version. Repositories expose only the requesting novel's rows and
never update past attempt evidence.

## Adapter And Service Design

1. Add a NovelPing extractor with pure canonicalization and bounded extraction.
   Its fetch client is injected and follows the existing three-redirect,
   5-second, 1 MB, HTML-only, HTTPS-host allowlist policy. Map timeout,
   upstream status, malformed HTML, and body limit to typed retryable source
   errors; never return upstream text to clients.
2. Extend the adapter registry with a narrow catalog-candidate operation rather
   than overloading chapter import. It accepts normalized novel evidence and a
   requested chapter number, returning candidate metadata, declared aliases,
   and an immutable catalog snapshot candidate.
3. Extract shared catalog identity persistence behind the existing catalog
   service. A provider may propose a snapshot but cannot replace a novel's
   accepted source or import content.
4. Implement `SourceResolutionService.resolveNovelPingChapter({ novelId,
   novelPingUrl })`: validate novel and URL, fetch/extract, call enabled
   adapters under per-provider bounds, normalize/score, persist the full
   decision in one transaction, and return a safe resolution resource.
5. Use a small in-process durable resolution job only if resolution requires
   more than the current request budget. Its target is exactly `{ attemptId }`,
   with the established four attempts, 15-second retry, pause/recovery, lease,
   and per-novel serialization rules. The synchronous first slice must still
   persist an attempt before provider calls and be idempotent. Do not add a
   background sweep or automatic re-resolution.

## API Contract

Update OpenAPI and the local Postman collection before routes. Keep local
responses novel-scoped, JSON-only, and free of raw upstream data.

| Method and resource | Contract |
| --- | --- |
| `POST /api/v1/novels/{novelId}/source-resolutions` | Accept exactly `{ novelPingUrl }` with optional `Idempotency-Key`. Return `201` for a persisted new attempt, `200` for identical replay, or a safe accepted/unresolved resource. It never imports chapters or creates a catalog-import job. |
| `GET /api/v1/novels/{novelId}/source-resolutions` | Return bounded newest-first attempt summaries and accepted source status for that novel only. |
| `GET /api/v1/novels/{novelId}/source-resolutions/{attemptId}` | Return normalized evidence summary, ranked candidates, decision, safe failure metadata, and import eligibility - not source-page HTML or translated prose. |
| `POST /api/v1/novels/{novelId}/source-resolutions/{attemptId}/catalog-import` | Require an accepted resolution owned by the novel, then delegate to existing `source_import_catalog` idempotent job creation. Reject unresolved, stale, conflicting, or foreign attempts. |

Stable errors: malformed URL/evidence `400 validation_error`; missing or foreign
novel/attempt `404 not_found`; ownership, stale resolution, or incompatible
accepted source `409 conflict`; retryable provider failure `502
source_fetch_failed`; exhausted/low-confidence/tied evidence `422
resolution_unverified`; unexpected failures `500 internal_error`. Document
`retryable` in every envelope and reject undeclared top-level properties.

## Reader UX

- In the novel workspace, provide a compact "Resolve from NovelPing" field and
  explicit Resolve action. Preserve the reading surface and keyboard navigation.
- Show one short state line: resolved source title and chapter evidence, needs
  review, retryable provider issue, or safe reason it cannot proceed. Do not
  show score internals by default, raw URLs, or upstream error text.
- Show "Import source chapters" only for a currently accepted, owned, current
  resolution. It invokes the existing import workspace and never starts on page
  load or navigation.
- Capture initiation token and novel ID around all async actions, following the
  existing stale-workspace guard. Desktop and mobile controls must not overflow
  or obscure prose.

## Observability, Privacy, And Safety

- Record attempt/candidate state transitions, adapter/version, duration,
  outcome code, and count of evaluated candidates in the existing safe job/event
  style. Do not log request HTML, translated prose, cookies, authorization,
  query strings, raw provider errors, or unredacted external URLs.
- Bound each provider's candidate count, fetch count, request body, redirects,
  and total resolver time. A failed provider is recorded without allowing it to
  lower a passing candidate below the evidence threshold.
- No user credentials, cookies, browser session, local file access, arbitrary
  outbound hosts, JavaScript execution, web-search scraping, or browser
  automation. Provider registration remains static application composition.

## Deterministic Fixtures And Tests

- NovelPing fixtures: canonical page, title/author variants, valid chapter
  2491 evidence, malformed/missing metadata, redirect rejection, content-type,
  timeout, body limit, and markup noise.
- Provider fixtures: Kujiang match, first non-Kujiang adapter match, no match,
  title collision, author conflict, exact-number mismatch, equal top score,
  cap/timeout, and ownership collision. Fixture data includes the documented
  Return of the War God/战神狂飙 chapter-2491 alignment only as test evidence.
- Migration/repository: clean and upgrade paths, immutability, idempotency,
  foreign-novel isolation, accepted-reference integrity, collision rejection,
  and no source/import side effects from unresolved attempts.
- Service/job: deterministic normalization/scoring, threshold/margin behavior,
  safe errors, retry sequence and fourth-attempt pause if durable dispatch is
  introduced, pause/resume/recovery, and stale-claim write rejection.
- HTTP/Postman/OpenAPI: strict payloads, idempotency replay/mismatch, all stable
  errors, delegated import only after acceptance, and no accidental job.
- Browser: accepted, unresolved, tied, retryable, and stale-action flows at
  desktop/mobile; inspect pixels and assert reading/navigation stay usable.

## Rollout And Completion

1. Land migration, repositories, and upgrade/ownership tests.
2. Land fixture-backed NovelPing extraction plus shared normalization/scoring.
3. Land Kujiang candidate discovery through the new interface, then one
   separately fixture-backed non-Kujiang catalog adapter.
4. Land atomic resolution service and, only if its bounded work cannot complete
   synchronously, durable dispatch/recovery support.
5. Land OpenAPI, local Postman examples/assertions, routes, and contract tests.
6. Land reader controls with stale-action coverage and pixel inspection.
7. Run `pnpm test`, `pnpm exec playwright test`, `pnpm exec redocly lint
   openapi/inktrail.v1.yaml`, local Postman collection JSON validation, markdown
   link checks available in the repository, and `git diff --check`.

## Explicit Non-Goals

- General search-engine scraping, browser automation, arbitrary website import,
  NovelPing chapter-chain crawling, background prefetch, or automatic import.
- Replacing current Kujiang importer behavior, changing translation/feedback/
  EPUB semantics, cloud sync, multi-process workers, user accounts, or remote
  shared queues.
- Machine-learning title matching, user-adjustable scoring, production endpoint
  assumptions from the example, live provider tests, or a generic adapter plugin
  framework.
