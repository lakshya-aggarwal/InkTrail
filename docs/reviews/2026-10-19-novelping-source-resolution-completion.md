# NovelPing Source Resolution Completion Review - 2026-10-19

## Status

Completed and independently reviewed clean.

## Delivered

InkTrail now resolves a canonical NovelPing chapter URL to a vetted Kujiang
catalog only when deterministic evidence passes the fixed
`novelping-kujiang-v1` policy. NovelPing extraction is bounded and
metadata-only. Kujiang discovery considers only static, configured source
identities and their declared aliases, holds candidates in memory, and limits
each resolution attempt to four candidate catalogs.

The resolver requires an exact chapter-number match, direct or declared-alias
matches for novel and chapter titles, and rejects author conflicts. The score
threshold is 95 out of 100, with a five-point unique-winner margin. Accepted
results atomically create or reuse the novel source, immutable catalog
snapshot, and resolution record while preserving existing source-ownership
rules. Unresolved and rejected attempts do not attach a source or create an
import job.

The local HTTP contract exposes scoped resolution list, create, and detail
resources, plus accepted-only catalog-import delegation. OpenAPI and the local
Postman collection document and exercise that contract. The reader adds compact
NovelPing resolution controls, an explicit accepted-only import action, and
stale-workspace guards so an action or response cannot affect a newly selected
novel or chapter. The import action remains hidden once its catalog already has
an import job; reading navigation and keyboard controls remain intact.

## Evidence

- Commits: `72e02c2`, `bf084d0`, `1bad273`, `0a83bf5`, `f95ca76`, `e6e3acb`,
  `2c93bfb`, `874874c`, `cdf6bf5`, `96efd4e`, and `03d1d54`.
- Full backend suite: 171/171 passing.
- Full Playwright desktop/mobile suite: 58/58 passing.
- Focused reader Playwright coverage: 12/12 passing.
- Redocly OpenAPI lint: warning-free.
- Postman collection JSON and 13 scripts: valid.
- `git diff --check`: clean.
- Independent desktop and mobile visual inspection: controls fit without
  obscuring prose; mobile controls stack naturally.

## Deliberate Limits

- No live NovelPing or Kujiang provider validation was performed.
- No general web search, crawling, browser automation, or NovelPing
  chapter-chain crawling is included.
- Resolution never auto-imports source chapters.
- Only configured, vetted Kujiang identities and declared aliases can match.
  Unknown novels fail closed as unresolved.

## Related Records

- [ADR 0006 - Resolve NovelPing Chapters Through Persisted Evidence](../decisions/0006-evidence-backed-novelping-source-resolution.md)
- [NovelPing Evidence-Backed Source Resolution Plan](../superpowers/plans/2026-10-17-inktrail-novelping-source-resolution.md)
- [NovelPing Source Resolution Plan Review](2026-10-17-novelping-source-resolution-plan-review.md)
