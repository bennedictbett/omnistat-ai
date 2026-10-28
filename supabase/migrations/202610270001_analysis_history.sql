create table public.analysis_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  title text not null check (char_length(title) between 1 and 200),
  result jsonb not null check (
    jsonb_typeof(result) = 'object'
    and result @> '{"ok": true}'::jsonb
    and octet_length(result::text) <= 5000000
  )
);

create index analysis_history_user_created_idx
  on public.analysis_history(user_id, created_at desc, id desc);

alter table public.analysis_history enable row level security;

revoke all on public.analysis_history from anon, authenticated;
grant select, insert, delete on public.analysis_history to authenticated;

create policy "Users read their own analyses" on public.analysis_history
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users save their own analyses" on public.analysis_history
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users delete their own analyses" on public.analysis_history
  for delete to authenticated using ((select auth.uid()) = user_id);
