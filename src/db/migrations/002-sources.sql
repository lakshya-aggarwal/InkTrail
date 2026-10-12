create table novel_sources (
  id text primary key,
  novel_id text not null references novels(id) on delete restrict,
  site text not null,
  external_novel_id text not null,
  source_url text not null,
  normalized_url text not null,
  title text,
  selected_at text not null,
  created_at text not null,
  unique (novel_id, site, external_novel_id),
  unique (site, normalized_url)
);

create table chapter_sources (
  id text primary key,
  novel_id text not null references novels(id) on delete restrict,
  chapter_id text not null references chapters(id) on delete restrict,
  novel_source_id text not null references novel_sources(id) on delete restrict,
  site text not null,
  external_chapter_id text not null,
  source_url text not null,
  normalized_url text not null,
  source_title text not null,
  previous_source_url text,
  next_source_url text,
  fetched_at text not null,
  content_sha256 text not null,
  created_at text not null,
  unique (chapter_id, site),
  unique (site, external_chapter_id)
);
