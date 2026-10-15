create temp table job_checkpoint_repair_validation (invalid integer);
create temp trigger job_checkpoint_repair_validation_failure
before insert on job_checkpoint_repair_validation
begin
  select raise(abort, 'repair required: cross-novel job checkpoints');
end;

insert into job_checkpoint_repair_validation (invalid)
select 1
where exists (
  select 1
  from jobs
  join chapters on chapters.id = jobs.current_chapter_id
  where chapters.novel_id <> jobs.novel_id
);

drop trigger job_checkpoint_repair_validation_failure;
drop table job_checkpoint_repair_validation;

create trigger chapters_job_checkpoint_ownership_on_update
before update of novel_id on chapters
for each row when new.novel_id <> old.novel_id and exists (
  select 1 from jobs where current_chapter_id = old.id
)
begin
  select raise(abort, 'chapter novel cannot change while job checkpoint exists');
end;
