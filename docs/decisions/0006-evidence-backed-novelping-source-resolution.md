# ADR 0006: Resolve NovelPing Chapters Through Persisted Evidence

## Status

Accepted - 2026-10-17

## Context

InkTrail can now discover a bounded Kujiang source catalog and explicitly import
it through durable jobs. It deliberately cannot turn a translated NovelPing
chapter URL into that catalog. The original user request needs that bridge, but
a guessed title match could attach the wrong Chinese novel or chapter to a
reader's library.

For example, current external evidence links NovelPing's Return of the War God
chapter 2491, "Shen Guanghai", to 战神狂飙 chapter 2491, 神光海. That evidence is
useful for designing the boundary, not a production endpoint guarantee. Source
sites and their markup remain unstable.

## Decision

Add an explicit, evidence-first resolver for one canonical NovelPing chapter
URL. It will:

- Canonicalize only supported HTTPS NovelPing chapter URLs, extract one bounded
  translated chapter page, and retain normalized novel title, optional author,
  chapter number, and chapter title as evidence - not imported content.
- Ask the existing Kujiang adapter to discover source-catalog candidates. The
  first resolver release has no second Chinese-source adapter. InkTrail will
  not use general web search, arbitrary scraping, browser automation,
  credentials, or client-side page execution. A new source site is a later,
  separately reviewed adapter boundary.
- Apply this fixed, code-owned acceptance rule. A candidate is eligible only
  when it has all three mandatory matches: exact positive chapter number (40
  points), source-novel title agreement (30 points), and chapter-title
  agreement (25 points). Title agreement means equality after NFKC, Unicode
  case-folding, whitespace collapse, and punctuation removal, either directly
  or against an adapter-declared alias for that exact source identity. The
  optional author match adds five points only when both sides have comparable
  normalized aliases. Missing author evidence adds zero; a comparable author
  mismatch rejects the candidate. The score is therefore 95 or 100, the fixed
  threshold is 95, and the winner must lead every other eligible candidate by
  at least five points. No title meaning is inferred by machine translation or
  unapproved romanization. Ties, missing mandatory evidence, conflicts, and
  a score below 95 reject the resolution.
- Keep provider candidate payloads in memory until scoring completes. Persist
  immutable resolution attempts, sanitized evidence observations, candidate
  identities, scores, provider versions, and terminal decision, but never a
  pre-acceptance `novel_sources` row or catalog snapshot. For an accepted
  decision, one SQLite transaction creates or reuses the source, creates or
  reuses the immutable snapshot, and stores the accepted resolution. The
  selected catalog remains separate from `chapters` and `chapter_sources`.
- Fail closed for insufficient evidence, equal top scores, cross-novel source
  ownership, a title/author conflict, or a chapter mismatch. A reader can see
  why a proposal was not accepted, but raw upstream pages and errors never
  enter the reader surface.
- Create no catalog-import job automatically. Only a passing resolution can
  expose an explicit reader action to start the existing catalog import flow.

## Consequences

- Resolution becomes an auditable novel-scoped decision, so concurrent local
  readers cannot silently share a source identity or overwrite a prior result.
- Providers remain small site-specific adapters. Adding a catalog provider
  requires fixtures, URL policy, deterministic parsing, and explicit registry
  registration rather than a generic scraper.
- The first release intentionally leaves an otherwise plausible NovelPing URL
  unresolved when Kujiang cannot provide the required declared aliases. It
  must never claim automatic Chinese-source coverage beyond supported adapters.
- Fetches retain the existing narrow HTTPS, redirect, timeout, body-size, and
  no-cookie policy. Retryable upstream failures use stable sanitized envelopes;
  validation, conflicts, and low-confidence results are non-retryable.
- Translation, feedback, EPUB, automatic catalog import, background crawling,
  NovelPing chain walking, and live-site verification remain outside this
  boundary.
