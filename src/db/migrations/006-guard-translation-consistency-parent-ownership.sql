create temp table translation_consistency_parent_validation (invalid integer);
create temp trigger translation_consistency_parent_validation_failure
before insert on translation_consistency_parent_validation
begin
  select raise(abort, 'repair required: cross-novel translation consistency records');
end;

insert into translation_consistency_parent_validation (invalid)
select 1
where exists (
  select 1
  from translation_quality_findings
  join translation_revisions on translation_revisions.id = translation_quality_findings.translation_revision_id
  join chapters on chapters.id = translation_revisions.chapter_id
  where chapters.novel_id <> translation_quality_findings.novel_id
)
or exists (
  select 1
  from feedback_reports
  join translation_revisions on translation_revisions.id = feedback_reports.translation_revision_id
  join chapters on chapters.id = translation_revisions.chapter_id
  where chapters.novel_id <> feedback_reports.novel_id
    or feedback_reports.chapter_id <> translation_revisions.chapter_id
);

drop trigger translation_consistency_parent_validation_failure;
drop table translation_consistency_parent_validation;

create trigger chapters_novel_ownership_on_update
before update of novel_id on chapters
for each row when new.novel_id <> old.novel_id and (
  exists (
    select 1
    from translation_quality_findings
    join translation_revisions on translation_revisions.id = translation_quality_findings.translation_revision_id
    where translation_revisions.chapter_id = old.id
  )
  or exists (
    select 1
    from feedback_reports
    where chapter_id = old.id
       or translation_revision_id in (select id from translation_revisions where chapter_id = old.id)
  )
)
begin
  select raise(abort, 'chapter novel cannot change while translation consistency records exist');
end;

create trigger translation_revisions_chapter_ownership_on_update
before update of chapter_id on translation_revisions
for each row when new.chapter_id <> old.chapter_id and (
  exists (select 1 from translation_quality_findings where translation_revision_id = old.id)
  or exists (select 1 from feedback_reports where translation_revision_id = old.id)
)
begin
  select raise(abort, 'translation revision chapter cannot change while translation consistency records exist');
end;
