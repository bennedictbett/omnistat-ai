-- Run against a development Supabase project after the audit migration.
-- Fixture users and events are rolled back.
begin;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);

insert into public.audit_events (action, procedure, dataset_hash, details)
  values ('upload_data', null, repeat('a', 64), '{"rows": 10}');
-- Client-supplied chain fields must be ignored.
insert into public.audit_events (action, procedure, seq, prev_hash, hash, details)
  values ('run_analysis', 'independent_t_test', 99, repeat('f', 64), repeat('e', 64), '{"ok": true}');
insert into public.audit_events (action, details) values ('export', '{"format": "docx"}');

do $$
declare
  rows public.audit_events[];
begin
  select array_agg(e order by e.seq) into rows from public.audit_events e;
  if array_length(rows, 1) <> 3 then raise exception 'Owner cannot read audit events'; end if;
  if rows[1].seq <> 1 or rows[2].seq <> 2 or rows[3].seq <> 3 then raise exception 'Sequence was not assigned by the database'; end if;
  if rows[1].prev_hash <> repeat('0', 64) then raise exception 'First entry should link to the zero hash'; end if;
  if rows[2].prev_hash <> rows[1].hash or rows[3].prev_hash <> rows[2].hash then raise exception 'Entries are not chained'; end if;
  if rows[2].hash = repeat('e', 64) then raise exception 'Client-supplied hash was accepted'; end if;
  if rows[2].hash <> public.audit_event_hash(rows[2]) then raise exception 'Stored hash does not match contents'; end if;
  if not (select ok from public.verify_audit_chain()) then raise exception 'Valid chain failed verification'; end if;

  begin
    insert into public.audit_events (user_id, action) values ('00000000-0000-0000-0000-0000000000b2', 'export');
    raise exception 'Forged owner was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.audit_events set details = '{"edited": true}' where seq = 2;
    raise exception 'Update was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.audit_events where seq = 3;
    raise exception 'Delete was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.audit_events (action) values ('delete_everything');
    raise exception 'Unknown action was accepted';
  exception when check_violation then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', true);
insert into public.audit_events (action) values ('run_analysis');
do $$
begin
  if (select count(*) from public.audit_events) <> 1 then raise exception 'Another user can read private audit events'; end if;
  if (select seq from public.audit_events) <> 1 then raise exception 'Chains are not separate per user'; end if;
  if (select events from public.verify_audit_chain()) <> 1 then raise exception 'Verification included another user'; end if;
end $$;

reset role;
do $$
begin
  if has_table_privilege('anon', 'public.audit_events', 'select') or has_table_privilege('anon', 'public.audit_events', 'insert') then
    raise exception 'Anonymous users have audit privileges';
  end if;
  if has_table_privilege('authenticated', 'public.audit_events', 'update')
    or has_table_privilege('authenticated', 'public.audit_events', 'delete')
    or has_table_privilege('authenticated', 'public.audit_events', 'truncate') then
    raise exception 'Audit events should not be editable';
  end if;
  begin
    truncate public.audit_events;
    raise exception 'Truncate was accepted';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Simulate a privileged tamper and confirm verification detects it.
alter table public.audit_events disable trigger audit_events_no_update_delete;
update public.audit_events set details = '{"ok": false}'
  where user_id = '00000000-0000-0000-0000-0000000000a1' and seq = 2;
alter table public.audit_events enable trigger audit_events_no_update_delete;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
do $$
declare
  v record;
begin
  select * into v from public.verify_audit_chain();
  if v.ok or v.first_invalid_seq <> 2 then raise exception 'Tampering was not detected: %', row_to_json(v); end if;
end $$;

rollback;
