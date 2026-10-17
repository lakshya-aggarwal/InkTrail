create temp table source_import_job_repair_validation (invalid integer);
create temp trigger source_import_job_repair_validation_failure
before insert on source_import_job_repair_validation
begin
  select raise(abort, 'repair required: invalid durable job records');
end;

insert into source_import_job_repair_validation (invalid)
select 1
where exists (
  select 1 from jobs
  left join chapters on chapters.id = jobs.current_chapter_id
  where jobs.type not in ('translate_chapters', 'build_epub')
    or (jobs.current_chapter_id is not null and (chapters.id is null or chapters.novel_id <> jobs.novel_id))
    or (jobs.type = 'build_epub' and jobs.current_chapter_id is not null)
    or (jobs.type = 'translate_chapters' and (json_valid(jobs.target_json) = 0 or not ((json_type(jobs.target_json, '$.startChapterNumber') = 'integer' and json_type(jobs.target_json, '$.endChapterNumber') = 'integer') or json_type(jobs.target_json, '$.chapterNumbers') = 'array')))
    or (jobs.type = 'build_epub' and (json_valid(jobs.target_json) = 0 or json_type(jobs.target_json, '$.exportId') is not 'text' or not exists (select 1 from epub_exports where epub_exports.id = json_extract(jobs.target_json, '$.exportId') and epub_exports.novel_id = jobs.novel_id)))
) or exists (
  select 1
  from job_attempts
  left join jobs on jobs.id = job_attempts.job_id
  left join chapters on chapters.id = job_attempts.chapter_id
  where jobs.id is null
    or job_attempts.novel_id <> jobs.novel_id
    or (job_attempts.chapter_id is not null and (chapters.id is null or chapters.novel_id <> jobs.novel_id))
    or (jobs.type = 'translate_chapters' and job_attempts.chapter_id is null)
    or (jobs.type = 'build_epub' and job_attempts.chapter_id is not null)
) or exists (
  select 1
  from job_events
  left join jobs on jobs.id = job_events.job_id
  left join chapters on chapters.id = job_events.chapter_id
  where jobs.id is null
    or job_events.novel_id <> jobs.novel_id
    or (job_events.chapter_id is not null and (chapters.id is null or chapters.novel_id <> jobs.novel_id))
);

drop trigger source_import_job_repair_validation_failure;
drop table source_import_job_repair_validation;

pragma defer_foreign_keys = on;

drop trigger job_attempts_ownership_on_insert;
drop trigger job_attempts_ownership_on_update;
drop trigger job_events_ownership_on_insert;
drop trigger job_events_ownership_on_update;
drop trigger jobs_novel_ownership_on_update;
drop trigger jobs_type_ownership_on_update;
drop trigger jobs_current_chapter_ownership_on_insert;
drop trigger jobs_current_chapter_ownership_on_update;
drop trigger build_epub_job_target_on_insert;
drop trigger build_epub_job_target_on_update;
drop trigger jobs_target_on_update;
drop trigger job_attempts_target_on_insert;
drop trigger job_attempts_target_on_update;
drop trigger job_attempts_claim_on_insert;
drop trigger job_attempts_claim_token_on_update;
drop trigger job_attempts_finish_claim_on_update;
drop trigger chapters_job_checkpoint_ownership_on_update;
drop trigger epub_exports_ownership_on_insert;
drop trigger epub_exports_ownership_on_update;
drop trigger chapters_job_export_ownership_on_update;
drop trigger epub_export_chapters_ascending_on_insert;
drop trigger epub_export_chapters_ascending_on_update;
drop trigger epub_export_chapters_ownership_on_insert;
drop trigger epub_export_chapters_ownership_on_update;
drop trigger epub_exports_novel_ownership_on_update;
drop trigger translation_revisions_export_ownership_on_update;

create table jobs_v11 (
  id text primary key,
  novel_id text not null references novels(id) on delete restrict,
  type text not null check (type in ('translate_chapters', 'build_epub', 'source_import_catalog')),
  target_json text not null,
  target_hash text not null,
  idempotency_key text,
  state text not null check (state in ('queued', 'running', 'retrying', 'paused', 'failed', 'completed')),
  priority integer not null,
  next_run_at text,
  claimed_at text,
  claim_token text,
  current_chapter_id text references chapters(id) on delete restrict,
  current_catalog_entry_id text references source_catalog_entries(id) on delete restrict,
  last_error_code text,
  last_error_message text,
  created_at text not null,
  updated_at text not null,
  completed_at text,
  unique (novel_id, type, idempotency_key)
);

create table job_attempts_v11 (
  id text primary key,
  job_id text not null references jobs_v11(id) on delete restrict,
  novel_id text not null references novels(id) on delete restrict,
  chapter_id text references chapters(id) on delete restrict,
  catalog_entry_id text references source_catalog_entries(id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0),
  state text not null check (state in ('started', 'succeeded', 'retryable_failed', 'paused_after_failure', 'abandoned_on_recovery')),
  started_at text not null,
  finished_at text,
  error_code text,
  error_message text,
  claim_token text,
  check ((chapter_id is null and catalog_entry_id is null) or (chapter_id is not null and catalog_entry_id is null) or (chapter_id is null and catalog_entry_id is not null))
);

create table job_events_v11 (
  id text primary key,
  job_id text not null references jobs_v11(id) on delete restrict,
  novel_id text not null references novels(id) on delete restrict,
  chapter_id text references chapters(id) on delete restrict,
  catalog_entry_id text references source_catalog_entries(id) on delete restrict,
  type text not null check (type in ('job_created', 'claimed', 'chapter_started', 'chapter_completed', 'catalog_entry_started', 'catalog_entry_completed', 'retry_scheduled', 'paused', 'resumed', 'recovered', 'failed', 'completed')),
  message text not null,
  details_json text not null,
  created_at text not null,
  check ((chapter_id is null and catalog_entry_id is null) or (chapter_id is not null and catalog_entry_id is null) or (chapter_id is null and catalog_entry_id is not null))
);

create table epub_exports_v11 (
  id text primary key,
  novel_id text not null references novels(id) on delete restrict,
  job_id text references jobs_v11(id) on delete restrict,
  state text not null check (state in ('queued', 'building', 'available', 'failed')),
  selection_json text not null,
  snapshot_at text not null,
  file_name text not null check (file_name not like '%/%' and file_name not like '%\\%' and file_name not like '%..%'),
  byte_size integer check (byte_size is null or byte_size >= 0),
  sha256 text check (sha256 is null or length(sha256) = 64),
  last_error_code text,
  last_error_message text,
  created_at text not null,
  updated_at text not null,
  completed_at text
);

create table epub_export_chapters_v11 (
  export_id text not null references epub_exports_v11(id) on delete restrict,
  chapter_id text not null references chapters(id) on delete restrict,
  translation_revision_id text not null references translation_revisions(id) on delete restrict,
  chapter_number integer not null check (chapter_number > 0),
  title text not null,
  source_url text not null,
  ordinal integer not null check (ordinal > 0),
  primary key (export_id, ordinal),
  unique (export_id, chapter_id)
);

insert into jobs_v11 (id, novel_id, type, target_json, target_hash, idempotency_key, state, priority, next_run_at, claimed_at, claim_token, current_chapter_id, current_catalog_entry_id, last_error_code, last_error_message, created_at, updated_at, completed_at)
select id, novel_id, type, target_json, target_hash, idempotency_key, state, priority, next_run_at, claimed_at, claim_token, current_chapter_id, null, last_error_code, last_error_message, created_at, updated_at, completed_at from jobs;
insert into job_attempts_v11 (id, job_id, novel_id, chapter_id, catalog_entry_id, attempt_number, state, started_at, finished_at, error_code, error_message, claim_token)
select id, job_id, novel_id, chapter_id, null, attempt_number, state, started_at, finished_at, error_code, error_message, claim_token from job_attempts;
insert into job_events_v11 (id, job_id, novel_id, chapter_id, catalog_entry_id, type, message, details_json, created_at)
select id, job_id, novel_id, chapter_id, null, type, message, details_json, created_at from job_events;
insert into epub_exports_v11 (id, novel_id, job_id, state, selection_json, snapshot_at, file_name, byte_size, sha256, last_error_code, last_error_message, created_at, updated_at, completed_at)
select id, novel_id, job_id, state, selection_json, snapshot_at, file_name, byte_size, sha256, last_error_code, last_error_message, created_at, updated_at, completed_at from epub_exports;
insert into epub_export_chapters_v11 (export_id, chapter_id, translation_revision_id, chapter_number, title, source_url, ordinal)
select export_id, chapter_id, translation_revision_id, chapter_number, title, source_url, ordinal from epub_export_chapters;

drop table epub_export_chapters;
drop table epub_exports;
drop table job_attempts;
drop table job_events;
drop table jobs;
alter table jobs_v11 rename to jobs;
alter table job_attempts_v11 rename to job_attempts;
alter table job_events_v11 rename to job_events;
alter table epub_exports_v11 rename to epub_exports;
alter table epub_export_chapters_v11 rename to epub_export_chapters;

create index jobs_runnable on jobs (state, next_run_at, priority, created_at);
create index jobs_by_novel_activity on jobs (novel_id, type, state);
create unique index one_active_translation_job_per_novel on jobs (novel_id) where type = 'translate_chapters' and state in ('queued', 'running', 'retrying');
create unique index one_active_source_import_job_per_novel on jobs (novel_id) where type = 'source_import_catalog' and state in ('queued', 'running', 'retrying');
create unique index job_attempts_per_chapter on job_attempts (job_id, chapter_id, attempt_number) where chapter_id is not null;
create unique index job_attempts_per_catalog_entry on job_attempts (job_id, catalog_entry_id, attempt_number) where catalog_entry_id is not null;
create unique index job_attempts_without_checkpoint on job_attempts (job_id, attempt_number) where chapter_id is null and catalog_entry_id is null;
create index job_attempts_by_job on job_attempts (job_id, chapter_id, catalog_entry_id, attempt_number);
create index job_events_by_job on job_events (job_id, created_at, id);
create index epub_exports_by_novel on epub_exports (novel_id, created_at, id);
create index epub_exports_by_job on epub_exports (job_id);
create index epub_export_chapters_by_snapshot on epub_export_chapters (export_id, ordinal);

create trigger jobs_checkpoint_ownership_on_insert
before insert on jobs
for each row when (new.current_chapter_id is not null and not exists (select 1 from chapters where id = new.current_chapter_id and novel_id = new.novel_id))
or (new.current_catalog_entry_id is not null and not exists (select 1 from source_catalog_entries where id = new.current_catalog_entry_id and novel_id = new.novel_id))
or (new.type <> 'translate_chapters' and new.current_chapter_id is not null)
or (new.type <> 'source_import_catalog' and new.current_catalog_entry_id is not null)
or (new.type = 'source_import_catalog' and (new.current_catalog_entry_id is not null and not exists (select 1 from source_catalog_entries where id = new.current_catalog_entry_id and catalog_id = json_extract(new.target_json, '$.catalogId'))))
begin select raise(abort, 'job checkpoint must belong to job novel'); end;

create trigger jobs_checkpoint_ownership_on_update
before update of novel_id, type, current_chapter_id, current_catalog_entry_id on jobs
for each row when (new.current_chapter_id is not null and not exists (select 1 from chapters where id = new.current_chapter_id and novel_id = new.novel_id))
or (new.current_catalog_entry_id is not null and not exists (select 1 from source_catalog_entries where id = new.current_catalog_entry_id and novel_id = new.novel_id))
or (new.type <> 'translate_chapters' and new.current_chapter_id is not null)
or (new.type <> 'source_import_catalog' and new.current_catalog_entry_id is not null)
or (new.type = 'source_import_catalog' and (new.current_catalog_entry_id is not null and not exists (select 1 from source_catalog_entries where id = new.current_catalog_entry_id and catalog_id = json_extract(new.target_json, '$.catalogId'))))
begin select raise(abort, 'job checkpoint must belong to job novel'); end;

create trigger source_import_job_target_on_insert
before insert on jobs
for each row when new.type = 'source_import_catalog' and (json_valid(new.target_json) = 0 or json_type(new.target_json, '$.catalogId') is not 'text' or (select count(*) from json_each(new.target_json)) <> 1 or not exists (select 1 from source_catalogs where id = json_extract(new.target_json, '$.catalogId') and novel_id = new.novel_id))
begin select raise(abort, 'source import job target must be a catalog owned by job novel'); end;

create trigger source_import_job_target_on_update
before update of novel_id, type, target_json on jobs
for each row when new.type = 'source_import_catalog' and (json_valid(new.target_json) = 0 or json_type(new.target_json, '$.catalogId') is not 'text' or (select count(*) from json_each(new.target_json)) <> 1 or not exists (select 1 from source_catalogs where id = json_extract(new.target_json, '$.catalogId') and novel_id = new.novel_id))
begin select raise(abort, 'source import job target must be a catalog owned by job novel'); end;

create trigger build_epub_job_target_on_insert before insert on jobs for each row when new.type = 'build_epub' and (json_valid(new.target_json) = 0 or json_type(new.target_json, '$.exportId') is not 'text' or not exists (select 1 from epub_exports where epub_exports.id = json_extract(new.target_json, '$.exportId') and epub_exports.novel_id = new.novel_id)) begin select raise(abort, 'EPUB job target must be an export owned by job novel'); end;
create trigger build_epub_job_target_on_update before update of novel_id, type, target_json on jobs for each row when new.type = 'build_epub' and (json_valid(new.target_json) = 0 or json_type(new.target_json, '$.exportId') is not 'text' or not exists (select 1 from epub_exports where epub_exports.id = json_extract(new.target_json, '$.exportId') and epub_exports.novel_id = new.novel_id)) begin select raise(abort, 'EPUB job target must be an export owned by job novel'); end;
create trigger jobs_target_on_update before update of target_json on jobs for each row when exists (select 1 from job_attempts where job_id = old.id) begin select raise(abort, 'job target cannot change while attempts exist'); end;
create trigger jobs_novel_ownership_on_update before update of novel_id on jobs for each row when new.novel_id <> old.novel_id and (exists (select 1 from job_attempts where job_id = old.id) or exists (select 1 from job_events where job_id = old.id) or exists (select 1 from epub_exports where job_id = old.id)) begin select raise(abort, 'job novel cannot change while dependent records exist'); end;
create trigger jobs_type_ownership_on_update before update of type on jobs for each row when new.type <> old.type and exists (select 1 from job_attempts where job_id = old.id) begin select raise(abort, 'job type cannot change while attempts exist'); end;
create trigger epub_exports_ownership_on_insert before insert on epub_exports for each row when new.job_id is not null and not exists (select 1 from jobs where id = new.job_id and novel_id = new.novel_id and type = 'build_epub') begin select raise(abort, 'EPUB export job must belong to novel'); end;
create trigger epub_exports_ownership_on_update before update of novel_id, job_id on epub_exports for each row when new.job_id is not null and not exists (select 1 from jobs where id = new.job_id and novel_id = new.novel_id and type = 'build_epub') begin select raise(abort, 'EPUB export job must belong to novel'); end;
create trigger chapters_job_export_ownership_on_update before update of novel_id on chapters for each row when new.novel_id <> old.novel_id and (exists (select 1 from job_attempts where chapter_id = old.id) or exists (select 1 from job_events where chapter_id = old.id) or exists (select 1 from epub_export_chapters where chapter_id = old.id)) begin select raise(abort, 'chapter novel cannot change while job or EPUB records exist'); end;
create trigger epub_exports_novel_ownership_on_update before update of novel_id on epub_exports for each row when new.novel_id <> old.novel_id and exists (select 1 from epub_export_chapters where export_id = old.id) begin select raise(abort, 'EPUB export novel cannot change while chapters exist'); end;
create trigger epub_export_chapters_ascending_on_insert after insert on epub_export_chapters for each row when exists (select 1 from epub_export_chapters as earlier join epub_export_chapters as later on later.export_id = earlier.export_id where earlier.export_id = new.export_id and earlier.ordinal < later.ordinal and earlier.chapter_number >= later.chapter_number) begin select raise(abort, 'EPUB export chapters must be in ascending chapter order'); end;
create trigger epub_export_chapters_ascending_on_update after update of ordinal, chapter_number on epub_export_chapters for each row when exists (select 1 from epub_export_chapters as earlier join epub_export_chapters as later on later.export_id = earlier.export_id where earlier.export_id = new.export_id and earlier.ordinal < later.ordinal and earlier.chapter_number >= later.chapter_number) begin select raise(abort, 'EPUB export chapters must be in ascending chapter order'); end;
create trigger epub_export_chapters_ownership_on_insert before insert on epub_export_chapters for each row when not exists (select 1 from epub_exports join chapters on chapters.id = new.chapter_id join translation_revisions on translation_revisions.id = new.translation_revision_id where epub_exports.id = new.export_id and chapters.novel_id = epub_exports.novel_id and translation_revisions.chapter_id = new.chapter_id and chapters.chapter_number = new.chapter_number and exists (select 1 from chapter_sources where chapter_id = new.chapter_id)) begin select raise(abort, 'EPUB export chapter must match snapshot provenance'); end;
create trigger epub_export_chapters_ownership_on_update before update of export_id, chapter_id, translation_revision_id, chapter_number on epub_export_chapters for each row when not exists (select 1 from epub_exports join chapters on chapters.id = new.chapter_id join translation_revisions on translation_revisions.id = new.translation_revision_id where epub_exports.id = new.export_id and chapters.novel_id = epub_exports.novel_id and translation_revisions.chapter_id = new.chapter_id and chapters.chapter_number = new.chapter_number and exists (select 1 from chapter_sources where chapter_id = new.chapter_id)) begin select raise(abort, 'EPUB export chapter must match snapshot provenance'); end;
create trigger translation_revisions_export_ownership_on_update before update of chapter_id on translation_revisions for each row when new.chapter_id <> old.chapter_id and exists (select 1 from epub_export_chapters where translation_revision_id = old.id) begin select raise(abort, 'translation revision chapter cannot change while EPUB records exist'); end;

create trigger job_attempts_target_on_insert
before insert on job_attempts
for each row when not exists (
  select 1 from jobs
  left join chapters on chapters.id = new.chapter_id
  left join source_catalog_entries on source_catalog_entries.id = new.catalog_entry_id
  where jobs.id = new.job_id and jobs.novel_id = new.novel_id and (
    (jobs.type = 'translate_chapters' and new.chapter_id is not null and new.catalog_entry_id is null and chapters.novel_id = jobs.novel_id and json_valid(jobs.target_json) = 1 and ((json_type(jobs.target_json, '$.startChapterNumber') = 'integer' and json_type(jobs.target_json, '$.endChapterNumber') = 'integer' and chapters.chapter_number between json_extract(jobs.target_json, '$.startChapterNumber') and json_extract(jobs.target_json, '$.endChapterNumber')) or exists (select 1 from json_each(jobs.target_json, '$.chapterNumbers') where value = chapters.chapter_number)))
    or (jobs.type = 'build_epub' and new.chapter_id is null and new.catalog_entry_id is null and json_valid(jobs.target_json) = 1 and exists (select 1 from epub_exports where id = json_extract(jobs.target_json, '$.exportId') and novel_id = jobs.novel_id))
    or (jobs.type = 'source_import_catalog' and new.chapter_id is null and new.catalog_entry_id is not null and source_catalog_entries.novel_id = jobs.novel_id and source_catalog_entries.catalog_id = json_extract(jobs.target_json, '$.catalogId'))
  )
)
begin select raise(abort, 'job attempt must match its job target'); end;
create trigger job_attempts_target_on_update before update of job_id, novel_id, chapter_id, catalog_entry_id on job_attempts for each row when not exists (select 1 from jobs left join chapters on chapters.id = new.chapter_id left join source_catalog_entries on source_catalog_entries.id = new.catalog_entry_id where jobs.id = new.job_id and jobs.novel_id = new.novel_id and ((jobs.type = 'translate_chapters' and new.chapter_id is not null and new.catalog_entry_id is null and chapters.novel_id = jobs.novel_id and ((json_type(jobs.target_json, '$.startChapterNumber') = 'integer' and json_type(jobs.target_json, '$.endChapterNumber') = 'integer' and chapters.chapter_number between json_extract(jobs.target_json, '$.startChapterNumber') and json_extract(jobs.target_json, '$.endChapterNumber')) or exists (select 1 from json_each(jobs.target_json, '$.chapterNumbers') where value = chapters.chapter_number))) or (jobs.type = 'build_epub' and new.chapter_id is null and new.catalog_entry_id is null and exists (select 1 from epub_exports where id = json_extract(jobs.target_json, '$.exportId') and novel_id = jobs.novel_id)) or (jobs.type = 'source_import_catalog' and new.chapter_id is null and new.catalog_entry_id is not null and source_catalog_entries.novel_id = jobs.novel_id and source_catalog_entries.catalog_id = json_extract(jobs.target_json, '$.catalogId')))) begin select raise(abort, 'job attempt must match its job target'); end;
create trigger job_attempts_claim_on_insert before insert on job_attempts for each row when new.state <> 'started' or not exists (select 1 from jobs where id = new.job_id and state = 'running' and claim_token = new.claim_token) begin select raise(abort, 'job attempt must begin under the active job claim'); end;
create trigger job_attempts_claim_token_on_update before update of claim_token on job_attempts for each row when new.claim_token is not old.claim_token begin select raise(abort, 'job attempt claim cannot change'); end;
create trigger job_attempts_finish_claim_on_update before update of state, finished_at, error_code, error_message on job_attempts for each row when old.state = 'started' and new.state <> 'started' and not exists (select 1 from jobs where id = new.job_id and state = 'running' and claim_token = old.claim_token) begin select raise(abort, 'only the active job claim may finalize an attempt'); end;

create trigger job_events_ownership_on_insert before insert on job_events for each row when not exists (select 1 from jobs left join chapters on chapters.id = new.chapter_id left join source_catalog_entries on source_catalog_entries.id = new.catalog_entry_id where jobs.id = new.job_id and jobs.novel_id = new.novel_id and (new.chapter_id is null or chapters.novel_id = jobs.novel_id) and (new.catalog_entry_id is null or (jobs.type = 'source_import_catalog' and source_catalog_entries.novel_id = jobs.novel_id and source_catalog_entries.catalog_id = json_extract(jobs.target_json, '$.catalogId')))) begin select raise(abort, 'job event must belong to job novel and target'); end;
create trigger job_events_ownership_on_update before update of job_id, novel_id, chapter_id, catalog_entry_id on job_events for each row when not exists (select 1 from jobs left join chapters on chapters.id = new.chapter_id left join source_catalog_entries on source_catalog_entries.id = new.catalog_entry_id where jobs.id = new.job_id and jobs.novel_id = new.novel_id and (new.chapter_id is null or chapters.novel_id = jobs.novel_id) and (new.catalog_entry_id is null or (jobs.type = 'source_import_catalog' and source_catalog_entries.novel_id = jobs.novel_id and source_catalog_entries.catalog_id = json_extract(jobs.target_json, '$.catalogId')))) begin select raise(abort, 'job event must belong to job novel and target'); end;
create trigger chapters_job_checkpoint_ownership_on_update before update of novel_id on chapters for each row when new.novel_id <> old.novel_id and exists (select 1 from jobs where current_chapter_id = old.id) begin select raise(abort, 'chapter novel cannot change while job checkpoint exists'); end;
create trigger catalog_entries_job_checkpoint_ownership_on_update before update of novel_id on source_catalog_entries for each row when new.novel_id <> old.novel_id and exists (select 1 from jobs where current_catalog_entry_id = old.id) begin select raise(abort, 'catalog entry novel cannot change while job checkpoint exists'); end;
