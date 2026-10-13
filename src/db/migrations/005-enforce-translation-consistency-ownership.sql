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
