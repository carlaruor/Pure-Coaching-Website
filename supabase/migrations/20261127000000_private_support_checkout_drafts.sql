-- Private, expiring booking drafts for future Stripe Checkout session creation.
-- This migration does not create purchases or verify payments. A future Stripe
-- webhook must create public.private_support_purchases only after payment is verified.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists private.private_support_checkout_drafts (
  id uuid primary key default gen_random_uuid(),
  opaque_reference uuid not null default gen_random_uuid() unique,
  client_request_id uuid not null unique,
  payload_hash text not null,
  booking_data jsonb not null,
  package_key text not null,
  package_name text not null,
  session_count smallint not null,
  total_amount_cents integer not null,
  currency text not null default 'AUD',
  stripe_price_id text not null,
  stripe_checkout_session_id text unique,
  stripe_checkout_url text,
  stripe_session_expires_at timestamptz,
  status text not null default 'creating',
  claim_count smallint not null default 1,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '48 hours'),
  constraint private_support_checkout_payload_hash_format
    check (payload_hash ~ '^[a-f0-9]{64}$'),
  constraint private_support_checkout_booking_data_object
    check (jsonb_typeof(booking_data) = 'object' and octet_length(booking_data::text) <= 16000),
  constraint private_support_checkout_package_key_allowed
    check (package_key in ('5-sessions', '10-sessions', '15-sessions')),
  constraint private_support_checkout_package_name_length
    check (length(btrim(package_name)) between 1 and 100),
  constraint private_support_checkout_session_count_allowed
    check (session_count in (5, 10, 15)),
  constraint private_support_checkout_amount_allowed
    check (total_amount_cents in (25000, 50000, 75000)),
  constraint private_support_checkout_package_catalog_consistent
    check (
      (package_key = '5-sessions' and package_name = '5 Sessions' and session_count = 5 and total_amount_cents = 25000)
      or (package_key = '10-sessions' and package_name = '10 Sessions' and session_count = 10 and total_amount_cents = 50000)
      or (package_key = '15-sessions' and package_name = '15 Sessions' and session_count = 15 and total_amount_cents = 75000)
    ),
  constraint private_support_checkout_currency_aud
    check (currency = 'AUD'),
  constraint private_support_checkout_price_id_format
    check (stripe_price_id ~ '^price_[A-Za-z0-9]+$' and length(stripe_price_id) <= 255),
  constraint private_support_checkout_session_id_format
    check (
      stripe_checkout_session_id is null
      or (
        stripe_checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9]+$'
        and length(stripe_checkout_session_id) <= 255
      )
    ),
  constraint private_support_checkout_url_length
    check (stripe_checkout_url is null or length(stripe_checkout_url) between 1 and 2048),
  constraint private_support_checkout_status_allowed
    check (status in ('creating', 'open', 'failed', 'expired', 'completed')),
  constraint private_support_checkout_claim_count
    check (claim_count between 1 and 5),
  constraint private_support_checkout_error_code_length
    check (last_error_code is null or length(last_error_code) between 1 and 100),
  constraint private_support_checkout_open_state_complete
    check (
      status <> 'open'
      or (
        stripe_checkout_session_id is not null
        and stripe_checkout_url is not null
        and stripe_session_expires_at is not null
      )
    ),
  constraint private_support_checkout_expiry_order
    check (expires_at > created_at)
);

alter table private.private_support_checkout_drafts enable row level security;

revoke all on table private.private_support_checkout_drafts from public, anon, authenticated;
grant all on table private.private_support_checkout_drafts to service_role;

create index if not exists private_support_checkout_drafts_expiry_idx
  on private.private_support_checkout_drafts (expires_at);

create index if not exists private_support_checkout_drafts_status_idx
  on private.private_support_checkout_drafts (status, updated_at);

create or replace function private.set_private_support_checkout_draft_updated_at()
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

revoke all on function private.set_private_support_checkout_draft_updated_at() from public, anon, authenticated;
grant execute on function private.set_private_support_checkout_draft_updated_at() to service_role;

drop trigger if exists set_private_support_checkout_draft_updated_at
  on private.private_support_checkout_drafts;
create trigger set_private_support_checkout_draft_updated_at
  before update on private.private_support_checkout_drafts
  for each row
  execute function private.set_private_support_checkout_draft_updated_at();

create or replace function private.claim_private_support_checkout_draft(
  p_client_request_id uuid,
  p_payload_hash text,
  p_booking_data jsonb,
  p_package_key text,
  p_package_name text,
  p_session_count smallint,
  p_total_amount_cents integer,
  p_currency text,
  p_stripe_price_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  draft private.private_support_checkout_drafts%rowtype;
begin
  delete from private.private_support_checkout_drafts
    where expires_at <= now();

  insert into private.private_support_checkout_drafts (
    client_request_id,
    payload_hash,
    booking_data,
    package_key,
    package_name,
    session_count,
    total_amount_cents,
    currency,
    stripe_price_id,
    lease_expires_at
  )
  values (
    p_client_request_id,
    p_payload_hash,
    p_booking_data,
    p_package_key,
    p_package_name,
    p_session_count,
    p_total_amount_cents,
    p_currency,
    p_stripe_price_id,
    now() + interval '2 minutes'
  )
  on conflict (client_request_id) do nothing
  returning * into draft;

  if draft.id is not null then
    return jsonb_build_object(
      'outcome', 'claimed',
      'reference', draft.opaque_reference,
      'claimCount', draft.claim_count
    );
  end if;

  select * into draft
    from private.private_support_checkout_drafts
    where client_request_id = p_client_request_id
    for update;

  if draft.id is null then
    raise exception 'Checkout draft claim could not be resolved';
  end if;

  if draft.payload_hash <> p_payload_hash then
    return jsonb_build_object('outcome', 'conflict');
  end if;

  if draft.status = 'open' then
    if draft.stripe_session_expires_at > now() then
      return jsonb_build_object(
        'outcome', 'existing',
        'reference', draft.opaque_reference,
        'checkoutUrl', draft.stripe_checkout_url,
        'sessionExpiresAt', draft.stripe_session_expires_at
      );
    end if;

    update private.private_support_checkout_drafts
      set status = 'expired', lease_expires_at = null
      where id = draft.id;
    return jsonb_build_object('outcome', 'expired');
  end if;

  if draft.status in ('failed', 'expired', 'completed') then
    return jsonb_build_object('outcome', draft.status);
  end if;

  if draft.lease_expires_at > now() then
    return jsonb_build_object('outcome', 'in_progress');
  end if;

  if draft.claim_count >= 5 then
    return jsonb_build_object('outcome', 'exhausted');
  end if;

  update private.private_support_checkout_drafts
    set claim_count = claim_count + 1,
        lease_expires_at = now() + interval '2 minutes'
    where id = draft.id
    returning * into draft;

  return jsonb_build_object(
    'outcome', 'claimed',
    'reference', draft.opaque_reference,
    'claimCount', draft.claim_count
  );
end;
$$;

create or replace function private.finalize_private_support_checkout_draft(
  p_reference uuid,
  p_payload_hash text,
  p_stripe_checkout_session_id text,
  p_stripe_checkout_url text,
  p_stripe_session_expires_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  updated_id uuid;
begin
  update private.private_support_checkout_drafts
    set status = 'open',
        stripe_checkout_session_id = p_stripe_checkout_session_id,
        stripe_checkout_url = p_stripe_checkout_url,
        stripe_session_expires_at = p_stripe_session_expires_at,
        lease_expires_at = null,
        last_error_code = null
    where opaque_reference = p_reference
      and payload_hash = p_payload_hash
      and status = 'creating'
      and expires_at > now()
    returning id into updated_id;

  return updated_id is not null;
end;
$$;

create or replace function private.fail_private_support_checkout_draft(
  p_reference uuid,
  p_payload_hash text,
  p_error_code text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  updated_id uuid;
begin
  update private.private_support_checkout_drafts
    set status = 'failed',
        lease_expires_at = null,
        last_error_code = left(p_error_code, 100)
    where opaque_reference = p_reference
      and payload_hash = p_payload_hash
      and status = 'creating'
    returning id into updated_id;

  return updated_id is not null;
end;
$$;

create or replace function private.cleanup_private_support_checkout_drafts()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  delete from private.private_support_checkout_drafts
    where expires_at <= now();
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function private.claim_private_support_checkout_draft(uuid, text, jsonb, text, text, smallint, integer, text, text) from public, anon, authenticated;
revoke all on function private.finalize_private_support_checkout_draft(uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function private.fail_private_support_checkout_draft(uuid, text, text) from public, anon, authenticated;
revoke all on function private.cleanup_private_support_checkout_drafts() from public, anon, authenticated;

grant execute on function private.claim_private_support_checkout_draft(uuid, text, jsonb, text, text, smallint, integer, text, text) to service_role;
grant execute on function private.finalize_private_support_checkout_draft(uuid, text, text, text, timestamptz) to service_role;
grant execute on function private.fail_private_support_checkout_draft(uuid, text, text) to service_role;
grant execute on function private.cleanup_private_support_checkout_drafts() to service_role;

-- PostgREST cannot call functions in the non-exposed private schema. These
-- wrappers retain the service-role caller's privileges and expose no table.
create or replace function public.claim_private_support_checkout_draft(
  p_client_request_id uuid,
  p_payload_hash text,
  p_booking_data jsonb,
  p_package_key text,
  p_package_name text,
  p_session_count smallint,
  p_total_amount_cents integer,
  p_currency text,
  p_stripe_price_id text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.claim_private_support_checkout_draft(
    p_client_request_id,
    p_payload_hash,
    p_booking_data,
    p_package_key,
    p_package_name,
    p_session_count,
    p_total_amount_cents,
    p_currency,
    p_stripe_price_id
  );
$$;

create or replace function public.finalize_private_support_checkout_draft(
  p_reference uuid,
  p_payload_hash text,
  p_stripe_checkout_session_id text,
  p_stripe_checkout_url text,
  p_stripe_session_expires_at timestamptz
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  select private.finalize_private_support_checkout_draft(
    p_reference,
    p_payload_hash,
    p_stripe_checkout_session_id,
    p_stripe_checkout_url,
    p_stripe_session_expires_at
  );
$$;

create or replace function public.fail_private_support_checkout_draft(
  p_reference uuid,
  p_payload_hash text,
  p_error_code text
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  select private.fail_private_support_checkout_draft(
    p_reference,
    p_payload_hash,
    p_error_code
  );
$$;

create or replace function public.cleanup_private_support_checkout_drafts()
returns integer
language sql
security invoker
set search_path = ''
as $$
  select private.cleanup_private_support_checkout_drafts();
$$;

revoke all on function public.claim_private_support_checkout_draft(uuid, text, jsonb, text, text, smallint, integer, text, text) from public, anon, authenticated;
revoke all on function public.finalize_private_support_checkout_draft(uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.fail_private_support_checkout_draft(uuid, text, text) from public, anon, authenticated;
revoke all on function public.cleanup_private_support_checkout_drafts() from public, anon, authenticated;

grant execute on function public.claim_private_support_checkout_draft(uuid, text, jsonb, text, text, smallint, integer, text, text) to service_role;
grant execute on function public.finalize_private_support_checkout_draft(uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.fail_private_support_checkout_draft(uuid, text, text) to service_role;
grant execute on function public.cleanup_private_support_checkout_drafts() to service_role;

notify pgrst, 'reload schema';
