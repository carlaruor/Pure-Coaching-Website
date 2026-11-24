-- Secure persistence for future Private Support package purchases.
-- This migration creates database infrastructure only. It does not implement
-- Stripe, questionnaire submission, email delivery or frontend behaviour.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists public.private_support_purchases (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  purchaser_first_name text not null,
  purchaser_last_name text not null,
  purchaser_email text not null,
  purchaser_phone text not null,
  package_name text not null,
  session_count smallint not null,
  total_amount_cents integer not null,
  currency text not null default 'AUD',
  payment_status text not null default 'pending',
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  payment_confirmed_at timestamptz,
  booking_data jsonb not null default '{}'::jsonb,
  questionnaire_data jsonb,
  questionnaire_completed_at timestamptz,
  email_status text not null default 'pending',
  email_sent_at timestamptz,
  email_attempt_count smallint not null default 0,
  email_last_attempt_at timestamptz,
  email_provider_id text,
  email_retryable boolean not null default false,
  constraint private_support_purchases_first_name_length
    check (length(btrim(purchaser_first_name)) between 1 and 100),
  constraint private_support_purchases_last_name_length
    check (length(btrim(purchaser_last_name)) between 1 and 100),
  constraint private_support_purchases_email_length
    check (length(btrim(purchaser_email)) between 3 and 254),
  constraint private_support_purchases_phone_length
    check (length(btrim(purchaser_phone)) between 8 and 30),
  constraint private_support_purchases_package_name_length
    check (length(btrim(package_name)) between 1 and 100),
  constraint private_support_purchases_session_count_positive
    check (session_count between 1 and 1000),
  constraint private_support_purchases_amount_positive
    check (total_amount_cents > 0),
  constraint private_support_purchases_currency_format
    check (currency ~ '^[A-Z]{3}$'),
  constraint private_support_purchases_payment_status_allowed
    check (payment_status in ('pending', 'processing', 'paid', 'failed', 'cancelled', 'refunded', 'partially_refunded')),
  constraint private_support_purchases_payment_confirmation_consistent
    check (
      (payment_status in ('paid', 'refunded', 'partially_refunded') and payment_confirmed_at is not null)
      or
      (payment_status in ('pending', 'processing', 'failed', 'cancelled') and payment_confirmed_at is null)
    ),
  constraint private_support_purchases_checkout_session_length
    check (stripe_checkout_session_id is null or length(stripe_checkout_session_id) between 1 and 255),
  constraint private_support_purchases_payment_intent_length
    check (stripe_payment_intent_id is null or length(stripe_payment_intent_id) between 1 and 255),
  constraint private_support_purchases_checkout_session_unique
    unique (stripe_checkout_session_id),
  constraint private_support_purchases_payment_intent_unique
    unique (stripe_payment_intent_id),
  constraint private_support_purchases_booking_data_object
    check (jsonb_typeof(booking_data) = 'object'),
  constraint private_support_purchases_questionnaire_data_object
    check (questionnaire_data is null or jsonb_typeof(questionnaire_data) = 'object'),
  constraint private_support_purchases_questionnaire_completion_consistent
    check (
      (questionnaire_data is null and questionnaire_completed_at is null)
      or
      (questionnaire_data is not null and questionnaire_completed_at is not null)
    ),
  constraint private_support_purchases_email_status_allowed
    check (email_status in ('pending', 'sent', 'failed')),
  constraint private_support_purchases_email_sent_consistent
    check (
      (email_status = 'sent' and email_sent_at is not null)
      or
      (email_status in ('pending', 'failed') and email_sent_at is null)
    ),
  constraint private_support_purchases_email_attempt_count
    check (email_attempt_count between 0 and 3),
  constraint private_support_purchases_email_provider_id_length
    check (email_provider_id is null or length(email_provider_id) <= 255)
);

alter table public.private_support_purchases enable row level security;

revoke all on table public.private_support_purchases from public, anon, authenticated;
grant all on table public.private_support_purchases to service_role;

create or replace function private.set_private_support_purchase_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function private.set_private_support_purchase_updated_at() from public, anon, authenticated;
grant execute on function private.set_private_support_purchase_updated_at() to service_role;

drop trigger if exists set_private_support_purchases_updated_at on public.private_support_purchases;
create trigger set_private_support_purchases_updated_at
  before update on public.private_support_purchases
  for each row
  execute function private.set_private_support_purchase_updated_at();

create index if not exists private_support_purchases_created_at_idx
  on public.private_support_purchases (created_at desc);

create index if not exists private_support_purchases_payment_status_idx
  on public.private_support_purchases (payment_status, created_at desc);

create index if not exists private_support_purchases_email_idx
  on public.private_support_purchases (lower(purchaser_email), created_at desc);

create index if not exists private_support_purchases_questionnaire_pending_idx
  on public.private_support_purchases (created_at desc)
  where payment_status = 'paid' and questionnaire_completed_at is null;

create index if not exists private_support_purchases_failed_email_retry_idx
  on public.private_support_purchases (email_last_attempt_at)
  where email_status = 'failed' and email_retryable and email_attempt_count < 3;

notify pgrst, 'reload schema';
