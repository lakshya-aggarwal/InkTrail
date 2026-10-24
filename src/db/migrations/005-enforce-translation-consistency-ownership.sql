create temp table translation_consistency_ownership_validation (invalid integer);
create temp trigger translation_consistency_ownership_validation_failure
before insert on translation_consistency_ownership_validation
begin
  select raise(abort, 'repair required: cross-novel translation consistency records');
end;

insert into translation_consistency_ownership_validation (invalid)
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

drop trigger translation_consistency_ownership_validation_failure;
drop table translation_consistency_ownership_validation;

create trigger translation_quality_findings_ownership_on_insert
before insert on translation_quality_findings
for each row when not exists (
  select 1
  from translation_revisions
  join chapters on chapters.id = translation_revisions.chapter_id
  where translation_revisions.id = new.translation_revision_id
    and chapters.novel_id = new.novel_id
)
begin
  select raise(abort, 'translation revision must belong to novel');
end;

create trigger translation_quality_findings_ownership_on_update
before update of novel_id, translation_revision_id on translation_quality_findings
for each row when not exists (
  select 1
  from translation_revisions
  join chapters on chapters.id = translation_revisions.chapter_id
  where translation_revisions.id = new.translation_revision_id
    and chapters.novel_id = new.novel_id
)
begin
  select raise(abort, 'translation revision must belong to novel');
end;

create trigger feedback_reports_ownership_on_insert
before insert on feedback_reports
for each row when not exists (
  select 1
  from chapters
  join translation_revisions on translation_revisions.chapter_id = chapters.id
  where chapters.id = new.chapter_id
    and chapters.novel_id = new.novel_id
    and translation_revisions.id = new.translation_revision_id
)
begin
  select raise(abort, 'feedback chapter and translation revision must belong to novel');
end;

create trigger feedback_reports_ownership_on_update
before update of novel_id, chapter_id, translation_revision_id on feedback_reports
for each row when not exists (
  select 1
  from chapters
  join translation_revisions on translation_revisions.chapter_id = chapters.id
  where chapters.id = new.chapter_id
    and chapters.novel_id = new.novel_id
    and translation_revisions.id = new.translation_revision_id
)
begin
  select raise(abort, 'feedback chapter and translation revision must belong to novel');
end;
