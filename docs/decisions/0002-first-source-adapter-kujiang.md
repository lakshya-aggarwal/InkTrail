# ADR 0002: Start Source Resolution With A Kujiang Adapter

## Status

Accepted - 2026-10-12

## Context

InkTrail needs original Chinese text before it can produce a trustworthy
retranslation. The legacy reader has working site-specific extraction for
Kujiang, Qmkan, NovelPing, and WTR-LAB, but that code is intentionally not a
dependency of InkTrail.

The first source slice needs a production-shaped adapter boundary without
committing InkTrail to broad scraping, speculative resolver heuristics, or a
translation workflow before source provenance is durable.

## Decision

Implement one first-party `kujiang` adapter for user-provided HTTPS Kujiang
chapter URLs. It will:

- recognize and canonicalize `https://www.kujiang.com/book/<book>/<chapter>`;
- parse only fixture-backed chapter metadata, Chinese body paragraphs, and
  previous and next source links;
- persist a selected novel source and a chapter source mapping separately from
  the existing chapter record;
- store the extracted Chinese text in `chapters.original_text` through the
  existing novel-scoped chapter boundary; and
- expose one local, synchronous import endpoint for a single chapter.

The adapter accepts an injected `fetch` implementation. Production fetching is
restricted to the supported HTTPS host, uses a timeout and response-size cap,
does not follow a redirect to an unsupported host, and converts upstream
failures into a retryable source error. Tests use static HTML fixtures and do
not call an external site.

## Consequences

This establishes source provenance and parsing contracts while keeping the
first slice small. It does not resolve NovelPing pages to Chinese sources,
walk a chapter chain, fetch in bulk, invoke Ollama, or run background jobs.
Those capabilities depend on the durable job model planned after source and
translation boundaries are established.
