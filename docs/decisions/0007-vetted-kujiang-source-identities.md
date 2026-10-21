# ADR 0007: Persist Vetted Kujiang Source Identities Per Novel

## Status

Accepted - 2026-10-20

## Decision

NovelPing source resolution reads candidate identities only from a durable
SQLite registry scoped to the requested InkTrail novel. Each identity contains
one canonical Kujiang book URL, its primary source title, optional novel and
author aliases, and optional aliases keyed by Kujiang external chapter ID.

The registry permits at most four identities for one novel. A canonical
Kujiang book URL is globally unique, so an identity cannot be attached to a
second InkTrail novel. SQLite foreign keys restrict deletion of the owning
novel while identities remain, and the repository validates structured alias
data before writing it.

A Kujiang canonical book URL also has one owner across the identity registry
and durable `novel_sources`. Direct catalog discovery rejects an identity
reserved by another novel before it creates a source or catalog, and SQLite
triggers enforce the same rule for direct insertions and ownership-bearing
updates in either table. Migration 14 is the published insert-only guard.
Migration 15 adds update guards for databases that already recorded migration
14. Migration 16 is the sole historical validation point: it validates rows
from databases that recorded the original insert-only migration 14 before their
schema version can advance. Migration 17 validates the four-identity bound for
historical rows and rejects moves that would make a fifth identity belong to a
novel. A conflict requires repair before the relevant validation migration can
complete.

`POST /api/v1/novels/{novelId}/source-identities` accepts only the documented
identity fields. `GET` lists a novel's identities, and `DELETE` removes one
identity in the same novel scope. There is no update endpoint: a correction is
an explicit delete followed by a new vetted identity.

Existing evidence extraction, candidate scoring, catalog fetching, atomic
acceptance, and source-import behavior remain unchanged. The Kujiang adapter
is constructed for each resolution from only the requesting novel's persisted
identities, while retaining its fixed four-candidate discovery bound.

## Consequences

- A production server no longer takes global fixture candidate identities at
  startup. Tests and local fixture workflows register the same identities via
  the scoped API.
- An empty registry fails closed as an unresolved source resolution. It does
  not broaden the resolver to title guessing or automatic source discovery.
- This is configuration for already vetted source identities, not an automatic
  crawler, catalog prefetcher, or general web-search mechanism.
- Existing source-resolution and catalog-import endpoints stay compatible;
  callers must register an identity before expecting a matching source to be
  discoverable.
