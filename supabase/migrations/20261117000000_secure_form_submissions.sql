-- Security controls required by the public submit-form Edge Function.
-- Review this migration in the target Supabase project before applying it.

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

create or replace function public.check_form_submission_rate_limit(
  p_rate_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
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

revoke all on function public.check_form_submission_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.check_form_submission_rate_limit(text, integer, integer) to service_role;

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
