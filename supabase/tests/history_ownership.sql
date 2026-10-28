-- Run against a development Supabase project after the migration.
-- All fixture users and results are rolled back.
begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'history-test-a@example.invalid'),
  ('00000000-0000-0000-0000-0000000000b2', 'history-test-b@example.invalid');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
insert into public.analysis_history (id, title, result) values
  ('00000000-0000-0000-0000-0000000000c3', 'Ownership fixture', '{"ok":true}');

do $$
begin
  if (select count(*) from public.analysis_history) <> 1 then
    raise exception 'Owner cannot read saved analysis';
  end if;
  begin
    insert into public.analysis_history (user_id, title, result)
      values ('00000000-0000-0000-0000-0000000000b2', 'Forged owner', '{"ok":true}');
    raise exception 'Forged owner insert was accepted';
  exception when insufficient_privilege then
    null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', true);
do $$
begin
  if exists (select 1 from public.analysis_history) then
    raise exception 'Another user can read private history';
  end if;
  delete from public.analysis_history;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
do $$
begin
  if (select count(*) from public.analysis_history) <> 1 then
    raise exception 'Another user deleted private history';
  end if;
  if has_table_privilege('anon', 'public.analysis_history', 'select')
    or has_table_privilege('anon', 'public.analysis_history', 'insert')
    or has_table_privilege('anon', 'public.analysis_history', 'delete') then
    raise exception 'Anonymous users have history privileges';
  end if;
  if has_table_privilege('authenticated', 'public.analysis_history', 'update') then
    raise exception 'Snapshots should not be editable';
  end if;
  delete from public.analysis_history;
  if exists (select 1 from public.analysis_history) then
    raise exception 'Owner cannot delete history';
  end if;
end $$;

rollback;
