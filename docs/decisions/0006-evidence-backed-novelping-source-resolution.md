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
- Ask explicit, registered site adapters to discover source-catalog candidates.
  The Kujiang catalog adapter is one provider; a second site-specific catalog
  adapter follows the same interface. InkTrail will not use general web search,
  arbitrary scraping, browser automation, credentials, or client-side page
  execution.
- Normalize novel title, author, chapter number, and chapter title
  independently. Cross-script comparisons use only an adapter-declared alias
  or deterministic Chinese romanization, never a guessed machine translation.
  A candidate passes only when deterministic evidence meets the configured
  threshold. Exact chapter number and chapter-title agreement are mandatory. A
  single winning source identity and catalog chapter must be unambiguous.
- Persist immutable resolution attempts, evidence observations, candidate
  identities, scores, provider versions, and terminal decision. The selected
  catalog is owned by the novel and remains separate from `chapters` and
  `chapter_sources`.
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
- Fetches retain the existing narrow HTTPS, redirect, timeout, body-size, and
  no-cookie policy. Retryable upstream failures use stable sanitized envelopes;
  validation, conflicts, and low-confidence results are non-retryable.
- Translation, feedback, EPUB, automatic catalog import, background crawling,
  NovelPing chain walking, and live-site verification remain outside this
  boundary.
