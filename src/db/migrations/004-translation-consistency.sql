create table translation_quality_findings (
  id text primary key,
  novel_id text not null references novels(id) on delete restrict,
  translation_revision_id text not null references translation_revisions(id) on delete restrict,
  kind text not null,
  details text not null,
  created_at text not null
);

create table memory_entries (
  id text primary key,
  novel_id text not null references novels(id) on delete restrict,
  source_term text not null,
  preferred_rendering text not null,
  semantic_scope text not null,
  evidence text not null,
  confidence real not null check (confidence >= 0 and confidence <= 1),
  created_at text not null,
  updated_at text not null,
  unique (novel_id, source_term, semantic_scope)
);

create table feedback_reports (
  id text primary key,
  novel_id text not null references novels(id) on delete restrict,
  chapter_id text not null references chapters(id) on delete restrict,
  translation_revision_id text not null references translation_revisions(id) on delete restrict,
  selected_text text not null,
  source_context text not null,
  translated_context text not null,
  proposed_correction text not null,
  reason text not null,
  status text not null check (status in ('pending', 'approved', 'rejected', 'needs_review')),
  created_at text not null,
  updated_at text not null
);

create index translation_quality_findings_by_revision on translation_quality_findings (translation_revision_id);
create index memory_entries_by_novel on memory_entries (novel_id, source_term, semantic_scope);
create index feedback_reports_by_chapter on feedback_reports (novel_id, chapter_id, created_at);
