create temp table kujiang_source_identity_ownership_repair_validation (invalid integer);
create temp trigger kujiang_source_identity_ownership_repair_validation_failure
before insert on kujiang_source_identity_ownership_repair_validation
begin
  select raise(abort, 'repair required: conflicting Kujiang source identity ownership');
end;

insert into kujiang_source_identity_ownership_repair_validation (invalid)
select 1
where exists (
  select 1
  from source_identities
  join novel_sources on novel_sources.site = 'kujiang'
    and novel_sources.normalized_url = source_identities.canonical_book_url
  where source_identities.site = 'kujiang'
    and source_identities.novel_id <> novel_sources.novel_id
);

drop trigger kujiang_source_identity_ownership_repair_validation_failure;
drop table kujiang_source_identity_ownership_repair_validation;

create trigger novel_sources_reject_foreign_kujiang_source_identity
before insert on novel_sources
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

create trigger source_identities_reject_foreign_kujiang_novel_source
before insert on source_identities
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
