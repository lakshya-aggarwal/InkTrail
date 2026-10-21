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
