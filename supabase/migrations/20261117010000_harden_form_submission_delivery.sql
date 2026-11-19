-- Add bounded notification-delivery metadata without rewriting or deleting
-- existing submissions. Apply only after reviewing the target table.

alter table public.form_submissions
  add column if not exists email_attempt_count smallint not null default 0,
  add column if not exists email_last_attempt_at timestamptz,
  add column if not exists email_provider_id text,
  add column if not exists email_retryable boolean not null default false;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'form_submissions'
      and (
        (column_name = 'email_attempt_count' and data_type <> 'smallint')
        or (column_name = 'email_last_attempt_at' and data_type <> 'timestamp with time zone')
        or (column_name = 'email_provider_id' and data_type <> 'text')
        or (column_name = 'email_retryable' and data_type <> 'boolean')
      )
  ) then
    raise exception 'Existing notification metadata columns are incompatible';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.form_submissions'::regclass
      and conname = 'form_submissions_email_attempt_count_check'
  ) then
    alter table public.form_submissions
      add constraint form_submissions_email_attempt_count_check
      check (email_attempt_count between 0 and 3);
  end if;
end;
$$;

create index if not exists form_submissions_failed_email_retry_idx
  on public.form_submissions (email_last_attempt_at)
  where email_status = 'failed' and email_retryable and email_attempt_count < 3;

revoke all on table public.form_submissions from anon, authenticated;
grant all on table public.form_submissions to service_role;
