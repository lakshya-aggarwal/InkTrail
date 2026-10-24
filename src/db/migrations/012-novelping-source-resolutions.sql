create temp table source_resolution_repair_validation (invalid integer);
create temp trigger source_resolution_repair_validation_failure
before insert on source_resolution_repair_validation
begin
  select raise(abort, 'repair required: invalid source resolution ownership');
end;

insert into source_resolution_repair_validation (invalid)
select 1
where exists (
  select 1
  from source_catalogs
  left join novel_sources on novel_sources.id = source_catalogs.novel_source_id
  where novel_sources.id is null
    or novel_sources.novel_id <> source_catalogs.novel_id
    or novel_sources.site <> source_catalogs.site
    or novel_sources.normalized_url <> source_catalogs.canonical_book_url
) or exists (
  select 1
  from source_catalog_entries
  left join source_catalogs on source_catalogs.id = source_catalog_entries.catalog_id
  where source_catalogs.id is null
    or source_catalogs.novel_id <> source_catalog_entries.novel_id
);

drop trigger source_resolution_repair_validation_failure;
drop table source_resolution_repair_validation;

create table source_resolution_attempts (
  id text primary key,
  novel_id text not null references novels(id) on delete restrict,
  canonical_novelping_url text not null,
  evidence_json text not null check (json_valid(evidence_json)),
  evidence_hash text not null check (length(evidence_hash) = 64 and evidence_hash not glob '*[^0-9a-f]*'),
  resolver_version text not null check (length(trim(resolver_version)) > 0),
  state text not null check (state in ('resolved', 'unresolved', 'failed')),
  error_code text,
  selected_candidate_id text references source_resolution_candidates(id) on delete restrict deferrable initially deferred,
  created_at text not null,
  check ((state = 'resolved' and selected_candidate_id is not null and error_code is null)
    or (state in ('unresolved', 'failed') and selected_candidate_id is null and error_code is not null and length(trim(error_code)) > 0))
);

create unique index source_resolution_attempt_replay
  on source_resolution_attempts (novel_id, canonical_novelping_url, evidence_hash, resolver_version)
  where state in ('resolved', 'unresolved');
create index source_resolution_attempts_by_novel
  on source_resolution_attempts (novel_id, created_at desc, id desc);

create table source_resolution_candidates (
  id text primary key,
  attempt_id text not null references source_resolution_attempts(id) on delete restrict deferrable initially deferred,
  novel_id text not null references novels(id) on delete restrict,
  adapter text not null check (length(trim(adapter)) > 0),
  site text not null check (length(trim(site)) > 0),
  canonical_source_identity text not null check (length(trim(canonical_source_identity)) > 0),
  content_sha256 text not null check (length(content_sha256) = 64 and content_sha256 not glob '*[^0-9a-f]*'),
  normalized_metadata_json text not null check (json_valid(normalized_metadata_json)),
  declared_aliases_json text not null check (json_valid(declared_aliases_json)),
  catalog_entry_ordinal integer not null check (catalog_entry_ordinal > 0),
  catalog_entry_external_id text not null check (length(trim(catalog_entry_external_id)) > 0),
  component_scores_json text not null check (json_valid(component_scores_json)),
  total_score integer not null check (total_score >= 0 and total_score <= 100),
  rank integer not null check (rank > 0),
  decision_reason text not null check (length(trim(decision_reason)) > 0),
  catalog_id text references source_catalogs(id) on delete restrict,
  created_at text not null,
  unique (attempt_id, rank),
  unique (attempt_id, canonical_source_identity)
);

create index source_resolution_candidates_by_attempt
  on source_resolution_candidates (attempt_id, rank);

create table novel_source_resolutions (
  id text primary key,
  novel_id text not null references novels(id) on delete restrict,
  canonical_novelping_url text not null,
  attempt_id text not null unique references source_resolution_attempts(id) on delete restrict deferrable initially deferred,
  candidate_id text not null unique references source_resolution_candidates(id) on delete restrict deferrable initially deferred,
  novel_source_id text not null references novel_sources(id) on delete restrict,
  catalog_id text not null references source_catalogs(id) on delete restrict,
  catalog_entry_id text not null references source_catalog_entries(id) on delete restrict,
  resolver_version text not null check (length(trim(resolver_version)) > 0),
  accepted_evidence_hash text not null check (length(accepted_evidence_hash) = 64 and accepted_evidence_hash not glob '*[^0-9a-f]*'),
  created_at text not null,
  unique (novel_id, canonical_novelping_url, resolver_version)
);

create index novel_source_resolutions_by_novel
  on novel_source_resolutions (novel_id, created_at desc, id desc);

create trigger source_resolution_candidates_ownership_on_insert
before insert on source_resolution_candidates
for each row when not exists (
  select 1 from source_resolution_attempts
  where id = new.attempt_id and novel_id = new.novel_id
) or (new.catalog_id is not null and not exists (
  select 1 from source_catalogs
  where id = new.catalog_id and novel_id = new.novel_id
))
begin
  select raise(abort, 'source resolution candidate must belong to attempt novel');
end;

create trigger source_resolution_candidates_immutable_on_update
before update on source_resolution_candidates
for each row
begin
  select raise(abort, 'source resolution candidates are immutable');
end;

create trigger source_resolution_candidates_immutable_on_delete
before delete on source_resolution_candidates
for each row
begin
  select raise(abort, 'source resolution candidates are immutable');
end;

create trigger source_resolution_attempts_immutable_on_update
before update on source_resolution_attempts
for each row
begin
  select raise(abort, 'source resolution attempts are immutable');
end;

create trigger source_resolution_attempts_immutable_on_delete
before delete on source_resolution_attempts
for each row
begin
  select raise(abort, 'source resolution attempts are immutable');
end;

create trigger novel_source_resolutions_ownership_on_insert
before insert on novel_source_resolutions
for each row when not exists (
  select 1
  from source_resolution_attempts
  join source_resolution_candidates on source_resolution_candidates.id = new.candidate_id
  join novel_sources on novel_sources.id = new.novel_source_id
  join source_catalogs on source_catalogs.id = new.catalog_id
  join source_catalog_entries on source_catalog_entries.id = new.catalog_entry_id
  where source_resolution_attempts.id = new.attempt_id
    and source_resolution_attempts.novel_id = new.novel_id
    and source_resolution_attempts.state = 'resolved'
    and source_resolution_attempts.selected_candidate_id = new.candidate_id
    and source_resolution_attempts.canonical_novelping_url = new.canonical_novelping_url
    and source_resolution_attempts.resolver_version = new.resolver_version
    and source_resolution_attempts.evidence_hash = new.accepted_evidence_hash
    and source_resolution_candidates.attempt_id = new.attempt_id
    and source_resolution_candidates.novel_id = new.novel_id
    and source_resolution_candidates.catalog_id = new.catalog_id
    and novel_sources.novel_id = new.novel_id
    and source_resolution_candidates.site = novel_sources.site
    and source_resolution_candidates.canonical_source_identity = novel_sources.normalized_url
    and source_catalogs.novel_id = new.novel_id
    and source_catalogs.novel_source_id = new.novel_source_id
    and source_resolution_candidates.site = source_catalogs.site
    and source_resolution_candidates.content_sha256 = source_catalogs.content_sha256
    and source_catalog_entries.catalog_id = new.catalog_id
    and source_catalog_entries.novel_id = new.novel_id
    and source_catalog_entries.ordinal = source_resolution_candidates.catalog_entry_ordinal
    and source_catalog_entries.external_chapter_id = source_resolution_candidates.catalog_entry_external_id
) or exists (
  select 1
  from novel_source_resolutions
  where novel_id = new.novel_id and novel_source_id <> new.novel_source_id
)
begin
  select raise(abort, 'accepted source resolution must own one novel source identity');
end;

create trigger novel_source_resolutions_immutable_on_update
before update on novel_source_resolutions
for each row
begin
  select raise(abort, 'accepted source resolutions are immutable');
end;

create trigger novel_source_resolutions_immutable_on_delete
before delete on novel_source_resolutions
for each row
begin
  select raise(abort, 'accepted source resolutions are immutable');
end;

create trigger source_resolution_candidates_catalog_state_on_insert
before insert on source_resolution_candidates
for each row when (new.catalog_id is not null and not exists (
  select 1 from source_resolution_attempts
  where id = new.attempt_id
    and novel_id = new.novel_id
    and state = 'resolved'
    and selected_candidate_id = new.id
) or (new.catalog_id is null and exists (
  select 1 from source_resolution_attempts
  where id = new.attempt_id
    and novel_id = new.novel_id
    and state = 'resolved'
    and selected_candidate_id = new.id
)))
begin
  select raise(abort, 'accepted candidate catalog shape is invalid');
end;
