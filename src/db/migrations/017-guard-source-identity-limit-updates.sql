create temp table source_identity_limit_repair_validation (invalid integer);
create temp trigger source_identity_limit_repair_validation_failure
before insert on source_identity_limit_repair_validation
begin
  select raise(abort, 'repair required: source identity limit exceeded');
end;

insert into source_identity_limit_repair_validation (invalid)
select 1
where exists (
  select 1
  from source_identities
  group by novel_id
  having count(*) > 4
);

drop trigger source_identity_limit_repair_validation_failure;
drop table source_identity_limit_repair_validation;

create trigger source_identities_max_four_on_novel_update
before update of novel_id on source_identities
when new.novel_id <> old.novel_id
  and (select count(*) from source_identities where novel_id = new.novel_id) >= 4
begin
  select raise(abort, 'source identity limit reached');
end;
