create table schema_migrations (
  version integer primary key,
  applied_at text not null
);

create table novels (
  id text primary key,
  title text not null,
  source_url text,
  created_at text not null,
  updated_at text not null
);

create table chapters (
  id text primary key,
  novel_id text not null references novels(id) on delete restrict,
  chapter_number integer not null check (chapter_number > 0),
  title text not null,
  original_text text,
  source_url text,
  created_at text not null,
  unique (novel_id, chapter_number)
);

create table translation_revisions (
  id text primary key,
  chapter_id text not null references chapters(id) on delete restrict,
  revision integer not null check (revision > 0),
  translated_text text not null,
  provider text not null,
  model text not null,
  created_at text not null,
  unique (chapter_id, revision)
);

create table reading_progress (
  novel_id text primary key references novels(id) on delete restrict,
  chapter_number integer not null check (chapter_number > 0),
  updated_at text not null
);
