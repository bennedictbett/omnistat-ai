-- Append-only, hash-chained audit log (specification section 12.3).
-- The database, not the browser, assigns the owner, time, sequence and hashes.
create extension if not exists pgcrypto with schema extensions;

create table public.audit_events (
  id bigint generated always as identity primary key,
  event_id uuid not null default gen_random_uuid() unique,
  -- No foreign key: entries are retained even if the account is later deleted.
  user_id uuid not null default auth.uid(),
  seq bigint not null,
  created_at timestamptz not null default now(),
  action text not null check (action in ('upload_data', 'run_analysis', 'save_history', 'export', 'ai_suggestion_accepted')),
  procedure text check (char_length(procedure) <= 100),
  engine text check (char_length(engine) <= 200),
  spec_hash text check (spec_hash ~ '^[0-9a-f]{64}$'),
  dataset_hash text check (dataset_hash ~ '^[0-9a-f]{64}$'),
  code_hash text check (code_hash ~ '^[0-9a-f]{64}$'),
  warnings jsonb not null default '[]'::jsonb
    check (jsonb_typeof(warnings) = 'array' and octet_length(warnings::text) <= 8000),
  result_bundle_id text check (char_length(result_bundle_id) <= 100),
  details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 8000),
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text not null unique check (hash ~ '^[0-9a-f]{64}$'),
  unique (user_id, seq)
);

-- Canonical text of everything an entry's hash covers; jsonb output has a fixed key order.
create function public.audit_event_payload(e public.audit_events)
returns text language sql immutable set search_path = '' as $$
  select jsonb_build_array(
    e.event_id, e.user_id, e.seq,
    to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    e.action, e.procedure, e.engine, e.spec_hash, e.dataset_hash, e.code_hash,
    e.warnings, e.result_bundle_id, e.details, e.prev_hash
  )::text
$$;

create function public.audit_event_hash(e public.audit_events)
returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest(public.audit_event_payload(e), 'sha256'), 'hex')
$$;

create function public.audit_events_chain()
returns trigger language plpgsql set search_path = '' as $$
declare
  previous record;
begin
  if auth.uid() is null then
    raise exception 'Audit events require a signed-in user' using errcode = '42501';
  end if;
  if new.user_id is distinct from auth.uid() then
    raise exception 'Audit events can only be recorded for the signed-in user' using errcode = '42501';
  end if;
  -- Serialises concurrent inserts (e.g. two tabs) so each user's sequence has no gaps or forks.
  perform pg_advisory_xact_lock(hashtextextended('audit:' || new.user_id::text, 0));
  select e.seq, e.hash into previous
    from public.audit_events e where e.user_id = new.user_id order by e.seq desc limit 1;
  new.event_id := gen_random_uuid();
  new.created_at := clock_timestamp();
  new.seq := coalesce(previous.seq, 0) + 1;
  new.prev_hash := coalesce(previous.hash, repeat('0', 64));
  new.hash := public.audit_event_hash(new);
  return new;
end $$;

create function public.audit_events_reject_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Audit events are append-only' using errcode = '42501';
end $$;

create trigger audit_events_chain before insert on public.audit_events
  for each row execute function public.audit_events_chain();
create trigger audit_events_no_update_delete before update or delete on public.audit_events
  for each row execute function public.audit_events_reject_change();
create trigger audit_events_no_truncate before truncate on public.audit_events
  for each statement execute function public.audit_events_reject_change();

alter table public.audit_events enable row level security;

revoke all on public.audit_events from anon, authenticated;
grant select, insert on public.audit_events to authenticated;

create policy "Users read their own audit events" on public.audit_events
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users record their own audit events" on public.audit_events
  for insert to authenticated with check ((select auth.uid()) = user_id);

-- Recomputes the signed-in user's chain. Edits, reordering, insertions or removal of
-- any entry except the newest are detected; compare exported counts to detect tail removal.
create function public.verify_audit_chain()
returns table (ok boolean, events bigint, first_invalid_seq bigint, reason text)
language plpgsql stable set search_path = '' as $$
declare
  e public.audit_events;
  expected_prev text := repeat('0', 64);
  expected_seq bigint := 1;
  checked bigint := 0;
begin
  if auth.uid() is null then
    raise exception 'Sign in to verify the audit log' using errcode = '42501';
  end if;
  for e in select * from public.audit_events a where a.user_id = auth.uid() order by a.seq loop
    checked := checked + 1;
    if e.seq <> expected_seq then
      return query select false, checked, e.seq, 'An entry is missing or out of order.'; return;
    elsif e.prev_hash <> expected_prev then
      return query select false, checked, e.seq, 'The link to the previous entry is broken.'; return;
    elsif e.hash <> public.audit_event_hash(e) then
      return query select false, checked, e.seq, 'The entry contents were changed.'; return;
    end if;
    expected_prev := e.hash;
    expected_seq := expected_seq + 1;
  end loop;
  return query select true, checked, null::bigint, null::text;
end $$;

revoke all on function public.verify_audit_chain() from public, anon;
grant execute on function public.verify_audit_chain() to authenticated;
revoke all on function public.audit_events_chain() from public, anon, authenticated;
revoke all on function public.audit_events_reject_change() from public, anon, authenticated;
