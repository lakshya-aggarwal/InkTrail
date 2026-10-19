create table source_identities (
  id text primary key,
  novel_id text not null references novels(id) on delete restrict,
  site text not null check (site = 'kujiang'),
  canonical_book_url text not null unique,
  novel_title text not null check (length(trim(novel_title)) > 0),
  novel_title_aliases_json text not null check (json_valid(novel_title_aliases_json) and json_type(novel_title_aliases_json) = 'array'),
  author text,
  author_aliases_json text not null check (json_valid(author_aliases_json) and json_type(author_aliases_json) = 'array'),
  chapter_title_aliases_json text not null check (json_valid(chapter_title_aliases_json) and json_type(chapter_title_aliases_json) = 'object'),
  created_at text not null
);

create index source_identities_by_novel on source_identities(novel_id, created_at, id);

create trigger source_identities_max_four_on_insert
before insert on source_identities
when (select count(*) from source_identities where novel_id = new.novel_id) >= 4
begin
  select raise(abort, 'source identity limit reached');
end;
