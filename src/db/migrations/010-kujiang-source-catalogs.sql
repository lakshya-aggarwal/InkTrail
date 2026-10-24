create table source_catalogs (
  id text primary key,
  novel_id text not null references novels(id) on delete restrict,
  novel_source_id text not null references novel_sources(id) on delete restrict,
  site text not null,
  canonical_book_url text not null,
  content_sha256 text not null check (length(content_sha256) = 64 and content_sha256 not glob '*[^0-9a-f]*'),
  entry_count integer not null check (entry_count > 0),
  created_at text not null,
  unique (novel_source_id, content_sha256)
);

create index source_catalogs_by_novel on source_catalogs (novel_id, created_at desc, id desc);

create table source_catalog_entries (
  id text primary key,
  catalog_id text not null references source_catalogs(id) on delete restrict,
  novel_id text not null references novels(id) on delete restrict,
  ordinal integer not null check (ordinal > 0),
  external_chapter_id text not null,
  source_url text not null,
  normalized_url text not null,
  source_title text not null,
  created_at text not null,
  unique (catalog_id, ordinal),
  unique (catalog_id, source_url),
  unique (catalog_id, normalized_url)
);

create index source_catalog_entries_by_catalog on source_catalog_entries (catalog_id, ordinal);

create trigger source_catalogs_ownership_on_insert
before insert on source_catalogs
for each row when not exists (
  select 1
  from novel_sources
  where novel_sources.id = new.novel_source_id
    and novel_sources.novel_id = new.novel_id
    and novel_sources.site = new.site
    and novel_sources.normalized_url = new.canonical_book_url
)
begin
  select raise(abort, 'source catalog must match its novel source');
end;

create trigger source_catalogs_immutable_on_update
before update on source_catalogs
for each row
begin
  select raise(abort, 'source catalogs are immutable');
end;

create trigger source_catalogs_immutable_on_delete
before delete on source_catalogs
for each row
begin
  select raise(abort, 'source catalogs are immutable');
end;

create trigger source_catalog_entries_ownership_on_insert
before insert on source_catalog_entries
for each row when not exists (
  select 1
  from source_catalogs
  where source_catalogs.id = new.catalog_id
    and source_catalogs.novel_id = new.novel_id
)
begin
  select raise(abort, 'source catalog entry must belong to catalog novel');
end;

create trigger source_catalog_entries_immutable_on_update
before update on source_catalog_entries
for each row
begin
  select raise(abort, 'source catalog entries are immutable');
end;

create trigger source_catalog_entries_immutable_on_delete
before delete on source_catalog_entries
for each row
begin
  select raise(abort, 'source catalog entries are immutable');
end;
