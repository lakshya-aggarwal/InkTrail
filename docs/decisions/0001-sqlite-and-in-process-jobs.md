# ADR 0001: SQLite And In-Process Jobs

## Status

Accepted on 2026-10-11.

## Decision

InkTrail uses one local SQLite database and an in-process job runner with
persisted job state.

## Rationale

The application is local-first and runs on one machine. SQLite provides
transactions, relational constraints, durable queue state, and simple backups
without operating another service. Persisted jobs retain pause, retry, and
recovery behavior across restarts while keeping deployment small.

Translations run sequentially within a novel to retain narrative context. The
runner permits bounded concurrency across different novels.

## Consequences

- Schema changes use versioned migrations.
- The runner must claim work transactionally and recover interrupted leases.
- Runtime database and EPUB files are ignored by Git.
- A future move to worker processes or remote execution can preserve the same
  database job contract if local concurrency becomes insufficient.
