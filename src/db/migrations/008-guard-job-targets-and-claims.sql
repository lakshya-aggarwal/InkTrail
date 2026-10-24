alter table job_attempts add column claim_token text;

create temp table durable_job_repair_validation (invalid integer);
create temp trigger durable_job_repair_validation_failure
before insert on durable_job_repair_validation
begin
  select raise(abort, 'repair required: invalid durable job ownership or target records');
end;

insert into durable_job_repair_validation (invalid)
select 1
where exists (
  select 1
  from jobs
  join chapters on chapters.id = jobs.current_chapter_id
  where chapters.novel_id <> jobs.novel_id
)
or exists (
  select 1
  from jobs
  where type = 'build_epub'
    and (
      json_valid(target_json) = 0
      or json_type(target_json, '$.exportId') is not 'text'
      or not exists (
        select 1 from epub_exports
        where epub_exports.id = json_extract(jobs.target_json, '$.exportId')
          and epub_exports.novel_id = jobs.novel_id
      )
    )
)
or exists (
  select 1
  from job_attempts
  join jobs on jobs.id = job_attempts.job_id
  left join chapters on chapters.id = job_attempts.chapter_id
  where (
    jobs.type = 'translate_chapters'
    and (
      job_attempts.chapter_id is null
      or chapters.novel_id <> jobs.novel_id
      or json_valid(jobs.target_json) = 0
      or not (
        (json_type(jobs.target_json, '$.startChapterNumber') = 'integer'
          and json_type(jobs.target_json, '$.endChapterNumber') = 'integer'
          and chapters.chapter_number between json_extract(jobs.target_json, '$.startChapterNumber') and json_extract(jobs.target_json, '$.endChapterNumber'))
        or exists (
          select 1 from json_each(jobs.target_json, '$.chapterNumbers')
          where json_each.value = chapters.chapter_number
        )
      )
    )
  ) or (
    jobs.type = 'build_epub'
    and (
      job_attempts.chapter_id is not null
      or json_valid(jobs.target_json) = 0
      or not exists (
        select 1 from epub_exports
        where epub_exports.id = json_extract(jobs.target_json, '$.exportId')
          and epub_exports.novel_id = jobs.novel_id
      )
    )
  )
);

drop trigger durable_job_repair_validation_failure;
drop table durable_job_repair_validation;

create trigger jobs_current_chapter_ownership_on_insert
before insert on jobs
for each row when new.current_chapter_id is not null and not exists (
  select 1 from chapters where id = new.current_chapter_id and novel_id = new.novel_id
)
begin
  select raise(abort, 'job checkpoint must belong to job novel');
end;

create trigger jobs_current_chapter_ownership_on_update
before update of novel_id, current_chapter_id on jobs
for each row when new.current_chapter_id is not null and not exists (
  select 1 from chapters where id = new.current_chapter_id and novel_id = new.novel_id
)
begin
  select raise(abort, 'job checkpoint must belong to job novel');
end;

create trigger build_epub_job_target_on_insert
before insert on jobs
for each row when new.type = 'build_epub' and (
  json_valid(new.target_json) = 0
  or json_type(new.target_json, '$.exportId') is not 'text'
  or not exists (
    select 1 from epub_exports
    where epub_exports.id = json_extract(new.target_json, '$.exportId')
      and epub_exports.novel_id = new.novel_id
  )
)
begin
  select raise(abort, 'EPUB job target must be an export owned by job novel');
end;

create trigger build_epub_job_target_on_update
before update of novel_id, type, target_json on jobs
for each row when new.type = 'build_epub' and (
  json_valid(new.target_json) = 0
  or json_type(new.target_json, '$.exportId') is not 'text'
  or not exists (
    select 1 from epub_exports
    where epub_exports.id = json_extract(new.target_json, '$.exportId')
      and epub_exports.novel_id = new.novel_id
  )
)
begin
  select raise(abort, 'EPUB job target must be an export owned by job novel');
end;

create trigger jobs_target_on_update
before update of target_json on jobs
for each row when exists (select 1 from job_attempts where job_id = old.id)
begin
  select raise(abort, 'job target cannot change while attempts exist');
end;

create trigger job_attempts_target_on_insert
before insert on job_attempts
for each row when not exists (
  select 1
  from jobs
  left join chapters on chapters.id = new.chapter_id
  where jobs.id = new.job_id
    and jobs.novel_id = new.novel_id
    and (
      (
        jobs.type = 'translate_chapters'
        and new.chapter_id is not null
        and chapters.novel_id = jobs.novel_id
        and json_valid(jobs.target_json) = 1
        and (
          (json_type(jobs.target_json, '$.startChapterNumber') = 'integer'
            and json_type(jobs.target_json, '$.endChapterNumber') = 'integer'
            and chapters.chapter_number between json_extract(jobs.target_json, '$.startChapterNumber') and json_extract(jobs.target_json, '$.endChapterNumber'))
          or exists (
            select 1 from json_each(jobs.target_json, '$.chapterNumbers')
            where json_each.value = chapters.chapter_number
          )
        )
      )
      or (
        jobs.type = 'build_epub'
        and new.chapter_id is null
        and json_valid(jobs.target_json) = 1
        and exists (
          select 1 from epub_exports
          where epub_exports.id = json_extract(jobs.target_json, '$.exportId')
            and epub_exports.novel_id = jobs.novel_id
        )
      )
    )
)
begin
  select raise(abort, 'job attempt must match its job target');
end;

create trigger job_attempts_target_on_update
before update of job_id, novel_id, chapter_id on job_attempts
for each row when not exists (
  select 1
  from jobs
  left join chapters on chapters.id = new.chapter_id
  where jobs.id = new.job_id
    and jobs.novel_id = new.novel_id
    and (
      (
        jobs.type = 'translate_chapters'
        and new.chapter_id is not null
        and chapters.novel_id = jobs.novel_id
        and json_valid(jobs.target_json) = 1
        and (
          (json_type(jobs.target_json, '$.startChapterNumber') = 'integer'
            and json_type(jobs.target_json, '$.endChapterNumber') = 'integer'
            and chapters.chapter_number between json_extract(jobs.target_json, '$.startChapterNumber') and json_extract(jobs.target_json, '$.endChapterNumber'))
          or exists (
            select 1 from json_each(jobs.target_json, '$.chapterNumbers')
            where json_each.value = chapters.chapter_number
          )
        )
      )
      or (
        jobs.type = 'build_epub'
        and new.chapter_id is null
        and json_valid(jobs.target_json) = 1
        and exists (
          select 1 from epub_exports
          where epub_exports.id = json_extract(jobs.target_json, '$.exportId')
            and epub_exports.novel_id = jobs.novel_id
        )
      )
    )
)
begin
  select raise(abort, 'job attempt must match its job target');
end;

create trigger job_attempts_claim_on_insert
before insert on job_attempts
for each row when new.state <> 'started' or not exists (
  select 1 from jobs
  where jobs.id = new.job_id
    and jobs.state = 'running'
    and jobs.claim_token = new.claim_token
)
begin
  select raise(abort, 'job attempt must begin under the active job claim');
end;

create trigger job_attempts_claim_token_on_update
before update of claim_token on job_attempts
for each row when new.claim_token is not old.claim_token
begin
  select raise(abort, 'job attempt claim cannot change');
end;

create trigger job_attempts_finish_claim_on_update
before update of state, finished_at, error_code, error_message on job_attempts
for each row when old.state = 'started' and new.state <> 'started' and not exists (
  select 1 from jobs
  where jobs.id = new.job_id
    and jobs.state = 'running'
    and jobs.claim_token = old.claim_token
)
begin
  select raise(abort, 'only the active job claim may finalize an attempt');
end;
