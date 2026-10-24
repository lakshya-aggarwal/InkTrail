# NovelPing Source Resolution Plan Repair Review

## Scope

This record closes the independent review findings for `67be51b`. It changes
documentation only and does not alter application behavior.

## Repairs

- `novelping-kujiang-v1` now has fixed 40/30/25/5 component weights, a 95-point
  threshold, a five-point unique-winner margin, explicit mandatory evidence,
  confidence-only author treatment, and a deterministic accept/reject matrix.
- Candidate catalog data remains in memory until it passes the evidence gate.
  The plan now names the transaction that creates or reuses the `novel_sources`
  record, immutable catalog snapshot, and accepted resolution together, while
  unresolved decisions retain no source or catalog ownership.
- The first implementation uses NovelPing plus the existing Kujiang adapter
  only. Other Chinese sources are deferred to separately reviewed adapters and
  must not be represented as automatic coverage.

## Verification

- Markdown links resolve within the repository.
- `git diff --check` reports no whitespace errors.

## Residual Risk

The v1 alias-only rule deliberately rejects books whose Kujiang metadata cannot
produce declared cross-script aliases. A later romanization or adapter expansion
needs its own evidence fixtures and review.
