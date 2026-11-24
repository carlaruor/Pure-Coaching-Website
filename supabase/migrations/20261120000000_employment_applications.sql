-- Secure persistence and private resume storage for Employment Expressions of Interest.
-- Review and apply this migration before deploying employment_interest handling.

create table if not exists public.employment_applications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  client_submission_id text not null unique,
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text not null,
  previous_support_experience boolean not null,
  experience_description text,
  motivation text,
  application_status text not null default 'new',
  resume_object_path text,
  email_status text not null default 'pending',
  email_sent_at timestamptz,
  email_attempt_count smallint not null default 0,
  email_last_attempt_at timestamptz,
  email_provider_id text,
  email_retryable boolean not null default false,
  constraint employment_applications_submission_id_format
    check (client_submission_id ~ '^[A-Za-z0-9-]{20,80}$'),
  constraint employment_applications_first_name_length
    check (length(btrim(first_name)) between 1 and 100),
  constraint employment_applications_last_name_length
    check (length(btrim(last_name)) between 1 and 100),
  constraint employment_applications_email_length
    check (length(btrim(email)) between 3 and 254),
  constraint employment_applications_phone_length
    check (length(btrim(phone)) between 8 and 30),
  constraint employment_applications_experience_length
    check (experience_description is null or length(experience_description) <= 5000),
  constraint employment_applications_motivation_length
    check (motivation is null or length(motivation) <= 5000),
  constraint employment_applications_status_allowed
    check (application_status in ('new', 'reviewing', 'shortlisted', 'unsuccessful', 'hired', 'withdrawn')),
  constraint employment_applications_resume_path_safe
    check (
      resume_object_path is null
      or (
        length(resume_object_path) between 1 and 512
        and resume_object_path !~ '(^/|\\|(^|/)\.\.(/|$)|[[:cntrl:]])'
        and resume_object_path ~ '/resume\.pdf$'
      )
    ),
  constraint employment_applications_email_status_allowed
    check (email_status in ('pending', 'sent', 'failed')),
  constraint employment_applications_email_attempt_count
    check (email_attempt_count between 0 and 3),
  constraint employment_applications_email_provider_id_length
    check (email_provider_id is null or length(email_provider_id) <= 255)
);

alter table public.employment_applications enable row level security;

revoke all on table public.employment_applications from anon, authenticated;
grant all on table public.employment_applications to service_role;

create index if not exists employment_applications_created_at_idx
  on public.employment_applications (created_at desc);

create index if not exists employment_applications_status_idx
  on public.employment_applications (application_status, created_at desc);

create index if not exists employment_applications_failed_email_retry_idx
  on public.employment_applications (email_last_attempt_at)
  where email_status = 'failed' and email_retryable and email_attempt_count < 3;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'employment-resumes',
  'employment-resumes',
  false,
  5242880,
  array['application/pdf']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Block direct access to employment resumes" on storage.objects;
create policy "Block direct access to employment resumes"
  on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (bucket_id <> 'employment-resumes')
  with check (bucket_id <> 'employment-resumes');

notify pgrst, 'reload schema';
