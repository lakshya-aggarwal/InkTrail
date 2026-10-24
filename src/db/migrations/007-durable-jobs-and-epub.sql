create table jobs (
  id text primary key,
  novel_id text not null references novels(id) on delete restrict,
  type text not null check (type in ('translate_chapters', 'build_epub')),
  target_json text not null,
  target_hash text not null,
  idempotency_key text,
  state text not null check (state in ('queued', 'running', 'retrying', 'paused', 'failed', 'completed')),
  priority integer not null,
  next_run_at text,
  claimed_at text,
  claim_token text,
  current_chapter_id text references chapters(id) on delete restrict,
  last_error_code text,
  last_error_message text,
  created_at text not null,
  updated_at text not null,
  completed_at text,
  unique (novel_id, type, idempotency_key)
);

create index jobs_runnable on jobs (state, next_run_at, priority, created_at);
create index jobs_by_novel_activity on jobs (novel_id, type, state);
create unique index one_active_translation_job_per_novel
  on jobs (novel_id)
  where type = 'translate_chapters' and state in ('queued', 'running', 'retrying');

create table job_attempts (
  id text primary key,
  job_id text not null references jobs(id) on delete restrict,
  novel_id text not null references novels(id) on delete restrict,
  chapter_id text references chapters(id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0),
  state text not null check (state in ('started', 'succeeded', 'retryable_failed', 'paused_after_failure', 'abandoned_on_recovery')),
  started_at text not null,
  finished_at text,
  error_code text,
  error_message text
);

create unique index job_attempts_per_chapter
  on job_attempts (job_id, chapter_id, attempt_number)
  where chapter_id is not null;
create unique index job_attempts_without_chapter
  on job_attempts (job_id, attempt_number)
  where chapter_id is null;
create index job_attempts_by_job on job_attempts (job_id, chapter_id, attempt_number);

create table job_events (
  id text primary key,
  job_id text not null references jobs(id) on delete restrict,
  novel_id text not null references novels(id) on delete restrict,
  chapter_id text references chapters(id) on delete restrict,
  type text not null check (type in ('job_created', 'claimed', 'chapter_started', 'chapter_completed', 'retry_scheduled', 'paused', 'resumed', 'recovered', 'failed', 'completed')),
  message text not null,
  details_json text not null,
  created_at text not null
);

create index job_events_by_job on job_events (job_id, created_at, id);

create table epub_exports (
  id text primary key,
  novel_id text not null references novels(id) on delete restrict,
  job_id text references jobs(id) on delete restrict,
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

create index epub_exports_by_novel on epub_exports (novel_id, created_at, id);
create index epub_exports_by_job on epub_exports (job_id);

create table epub_export_chapters (
  export_id text not null references epub_exports(id) on delete restrict,
  chapter_id text not null references chapters(id) on delete restrict,
  translation_revision_id text not null references translation_revisions(id) on delete restrict,
  chapter_number integer not null check (chapter_number > 0),
  title text not null,
  source_url text not null,
  ordinal integer not null check (ordinal > 0),
  primary key (export_id, ordinal),
  unique (export_id, chapter_id)
);

create index epub_export_chapters_by_snapshot on epub_export_chapters (export_id, ordinal);

create trigger epub_export_chapters_ascending_on_insert
after insert on epub_export_chapters
for each row when exists (
  select 1
  from epub_export_chapters as earlier
  join epub_export_chapters as later on later.export_id = earlier.export_id
  where earlier.export_id = new.export_id
    and earlier.ordinal < later.ordinal
    and earlier.chapter_number >= later.chapter_number
)
begin
  select raise(abort, 'EPUB export chapters must be in ascending chapter order');
end;

create trigger epub_export_chapters_ascending_on_update
after update of ordinal, chapter_number on epub_export_chapters
for each row when exists (
  select 1
  from epub_export_chapters as earlier
  join epub_export_chapters as later on later.export_id = earlier.export_id
  where earlier.export_id = new.export_id
    and earlier.ordinal < later.ordinal
    and earlier.chapter_number >= later.chapter_number
)
begin
  select raise(abort, 'EPUB export chapters must be in ascending chapter order');
end;

create trigger job_attempts_ownership_on_insert
before insert on job_attempts
for each row when not exists (
  select 1 from jobs where id = new.job_id and novel_id = new.novel_id
) or (new.chapter_id is not null and not exists (
  select 1 from chapters where id = new.chapter_id and novel_id = new.novel_id
)) or exists (
  select 1 from jobs where id = new.job_id and type = 'translate_chapters' and new.chapter_id is null
) or exists (
  select 1 from jobs where id = new.job_id and type = 'build_epub' and new.chapter_id is not null
)
begin
  select raise(abort, 'job attempt must match job, novel, and checkpoint type');
end;

create trigger job_attempts_ownership_on_update
before update of job_id, novel_id, chapter_id on job_attempts
for each row when not exists (
  select 1 from jobs where id = new.job_id and novel_id = new.novel_id
) or (new.chapter_id is not null and not exists (
  select 1 from chapters where id = new.chapter_id and novel_id = new.novel_id
)) or exists (
  select 1 from jobs where id = new.job_id and type = 'translate_chapters' and new.chapter_id is null
) or exists (
  select 1 from jobs where id = new.job_id and type = 'build_epub' and new.chapter_id is not null
)
begin
  select raise(abort, 'job attempt must match job, novel, and checkpoint type');
end;

create trigger job_events_ownership_on_insert
before insert on job_events
for each row when not exists (
  select 1 from jobs where id = new.job_id and novel_id = new.novel_id
) or (new.chapter_id is not null and not exists (
  select 1 from chapters where id = new.chapter_id and novel_id = new.novel_id
))
begin
  select raise(abort, 'job event must belong to job novel');
end;

create trigger job_events_ownership_on_update
before update of job_id, novel_id, chapter_id on job_events
for each row when not exists (
  select 1 from jobs where id = new.job_id and novel_id = new.novel_id
) or (new.chapter_id is not null and not exists (
  select 1 from chapters where id = new.chapter_id and novel_id = new.novel_id
))
begin
  select raise(abort, 'job event must belong to job novel');
end;

create trigger epub_exports_ownership_on_insert
before insert on epub_exports
for each row when new.job_id is not null and not exists (
  select 1 from jobs where id = new.job_id and novel_id = new.novel_id and type = 'build_epub'
)
begin
  select raise(abort, 'EPUB export job must belong to novel');
end;

create trigger epub_exports_ownership_on_update
before update of novel_id, job_id on epub_exports
for each row when new.job_id is not null and not exists (
  select 1 from jobs where id = new.job_id and novel_id = new.novel_id and type = 'build_epub'
)
begin
  select raise(abort, 'EPUB export job must belong to novel');
end;

create trigger epub_export_chapters_ownership_on_insert
before insert on epub_export_chapters
for each row when not exists (
  select 1
  from epub_exports
  join chapters on chapters.id = new.chapter_id
  join translation_revisions on translation_revisions.id = new.translation_revision_id
  where epub_exports.id = new.export_id
    and chapters.novel_id = epub_exports.novel_id
    and translation_revisions.chapter_id = new.chapter_id
    and chapters.chapter_number = new.chapter_number
    and exists (select 1 from chapter_sources where chapter_id = new.chapter_id)
)
begin
  select raise(abort, 'EPUB export chapter must match snapshot provenance');
end;

create trigger epub_export_chapters_ownership_on_update
before update of export_id, chapter_id, translation_revision_id, chapter_number on epub_export_chapters
for each row when not exists (
  select 1
  from epub_exports
  join chapters on chapters.id = new.chapter_id
  join translation_revisions on translation_revisions.id = new.translation_revision_id
  where epub_exports.id = new.export_id
    and chapters.novel_id = epub_exports.novel_id
    and translation_revisions.chapter_id = new.chapter_id
    and chapters.chapter_number = new.chapter_number
    and exists (select 1 from chapter_sources where chapter_id = new.chapter_id)
)
begin
  select raise(abort, 'EPUB export chapter must match snapshot provenance');
end;

create trigger jobs_novel_ownership_on_update
before update of novel_id on jobs
for each row when new.novel_id <> old.novel_id and (
  exists (select 1 from job_attempts where job_id = old.id)
  or exists (select 1 from job_events where job_id = old.id)
  or exists (select 1 from epub_exports where job_id = old.id)
)
begin
  select raise(abort, 'job novel cannot change while dependent records exist');
end;

create trigger jobs_type_ownership_on_update
before update of type on jobs
for each row when new.type <> old.type and exists (
  select 1 from job_attempts where job_id = old.id
)
begin
  select raise(abort, 'job type cannot change while attempts exist');
end;

create trigger epub_exports_novel_ownership_on_update
before update of novel_id on epub_exports
for each row when new.novel_id <> old.novel_id and exists (
  select 1 from epub_export_chapters where export_id = old.id
)
begin
  select raise(abort, 'EPUB export novel cannot change while chapters exist');
end;

create trigger chapters_job_export_ownership_on_update
before update of novel_id on chapters
for each row when new.novel_id <> old.novel_id and (
  exists (select 1 from job_attempts where chapter_id = old.id)
  or exists (select 1 from job_events where chapter_id = old.id)
  or exists (select 1 from epub_export_chapters where chapter_id = old.id)
)
begin
  select raise(abort, 'chapter novel cannot change while job or EPUB records exist');
end;

create trigger translation_revisions_export_ownership_on_update
before update of chapter_id on translation_revisions
for each row when new.chapter_id <> old.chapter_id and exists (
  select 1 from epub_export_chapters where translation_revision_id = old.id
)
begin
  select raise(abort, 'translation revision chapter cannot change while EPUB records exist');
end;
