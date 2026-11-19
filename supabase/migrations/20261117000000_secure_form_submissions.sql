-- Security controls required by the public submit-form Edge Function.
-- Review this migration in the target Supabase project before applying it.

-- Fail before applying security changes if the existing table is not compatible
-- with the schema this function was designed for. No table data is rewritten.
do $$
begin
  if to_regclass('public.form_submissions') is null then
    raise exception 'Required table public.form_submissions does not exist';
  end if;

  if (
    select count(*)
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'form_submissions'
      and column_name in (
        'id',
        'created_at',
        'form_type',
        'form_data',
        'attachments',
        'email_status',
        'email_sent_at'
      )
  ) <> 7 then
    raise exception 'public.form_submissions is missing one or more required columns';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'form_submissions'
      and column_name in ('form_data', 'attachments')
      and data_type <> 'jsonb'
  ) then
    raise exception 'form_data and attachments must both be jsonb columns';
  end if;
end;
$$;

alter table public.form_submissions enable row level security;

revoke all on table public.form_submissions from anon, authenticated;
grant all on table public.form_submissions to service_role;

-- A browser-generated identifier makes retries idempotent without exposing a
-- sequential database identifier or permitting public database access.
create unique index if not exists form_submissions_client_submission_id_idx
  on public.form_submissions ((form_data ->> 'clientSubmissionId'))
  where form_data ? 'clientSubmissionId';

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists private.form_submission_rate_limits (
  rate_key text primary key,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 1 check (request_count > 0)
);

revoke all on table private.form_submission_rate_limits from public, anon, authenticated;
grant all on table private.form_submission_rate_limits to service_role;

-- The implementation stays in the non-exposed private schema. The Edge
-- Function reaches it through a narrowly scoped public PostgREST wrapper below.
create or replace function private.check_form_submission_rate_limit(
  p_rate_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_count integer;
begin
  if p_rate_key is null or length(p_rate_key) <> 64
     or p_limit < 1 or p_limit > 100
     or p_window_seconds < 60 or p_window_seconds > 86400 then
    raise exception 'Invalid rate-limit parameters';
  end if;

  delete from private.form_submission_rate_limits
    where window_started_at < now() - interval '2 days';

  insert into private.form_submission_rate_limits (rate_key, window_started_at, request_count)
  values (p_rate_key, now(), 1)
  on conflict (rate_key) do update
    set window_started_at = case
          when private.form_submission_rate_limits.window_started_at <= now() - make_interval(secs => p_window_seconds)
            then now()
          else private.form_submission_rate_limits.window_started_at
        end,
        request_count = case
          when private.form_submission_rate_limits.window_started_at <= now() - make_interval(secs => p_window_seconds)
            then 1
          else private.form_submission_rate_limits.request_count + 1
        end
  returning request_count into current_count;

  return current_count <= p_limit;
end;
$$;

revoke all on function private.check_form_submission_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function private.check_form_submission_rate_limit(text, integer, integer) to service_role;

-- PostgREST cannot call routines in a schema that is not configured as an
-- exposed schema. This public wrapper is therefore the only Data API entry
-- point. SECURITY INVOKER means it retains the service_role caller's grants;
-- it cannot elevate anon/authenticated callers, which also lack EXECUTE.
create or replace function public.enforce_form_submission_rate_limit(
  p_rate_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  select private.check_form_submission_rate_limit(
    p_rate_key,
    p_limit,
    p_window_seconds
  );
$$;

revoke all on function public.enforce_form_submission_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.enforce_form_submission_rate_limit(text, integer, integer) to service_role;

-- Remove the superseded exposed implementation if an earlier draft of this
-- migration was applied during local testing. This does not touch table data.
drop function if exists public.check_form_submission_rate_limit(text, integer, integer);

do $$
begin
  if not exists (select 1 from storage.buckets where id = 'referral-documents') then
    raise exception 'Required private Storage bucket referral-documents does not exist';
  end if;
end;
$$;

update storage.buckets
set public = false
where id = 'referral-documents';

-- Restrictive policies are ANDed with any existing permissive policies. This
-- prevents broad or future anon/authenticated policies from granting direct
-- access to this sensitive bucket while leaving other buckets unaffected.
drop policy if exists "Block direct access to referral documents" on storage.objects;
create policy "Block direct access to referral documents"
  on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (bucket_id <> 'referral-documents')
  with check (bucket_id <> 'referral-documents');

notify pgrst, 'reload schema';
