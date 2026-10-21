create trigger novel_sources_reject_foreign_kujiang_source_identity_update
before update of novel_id, site, normalized_url on novel_sources
when new.site = 'kujiang' and exists (
  select 1
  from source_identities
  where site = 'kujiang'
    and canonical_book_url = new.normalized_url
    and novel_id <> new.novel_id
)
begin
  select raise(abort, 'Kujiang source identity belongs to another novel');
end;

create trigger source_identities_reject_foreign_kujiang_novel_source_update
before update of novel_id, site, canonical_book_url on source_identities
when new.site = 'kujiang' and exists (
  select 1
  from novel_sources
  where site = 'kujiang'
    and normalized_url = new.canonical_book_url
    and novel_id <> new.novel_id
)
begin
  select raise(abort, 'Kujiang source already belongs to another novel');
end;
