create trigger chapters_job_checkpoint_ownership_on_update
before update of novel_id on chapters
for each row when new.novel_id <> old.novel_id and exists (
  select 1 from jobs where current_chapter_id = old.id
)
begin
  select raise(abort, 'chapter novel cannot change while job checkpoint exists');
end;
