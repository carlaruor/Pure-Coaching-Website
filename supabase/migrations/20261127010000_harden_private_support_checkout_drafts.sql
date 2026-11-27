-- Incremental hardening for the already-applied checkout draft migration.
-- Persist immutable Stripe request inputs for safe API v1 idempotency retries
-- and retain expired operational drafts temporarily for webhook reconciliation.

alter table private.private_support_checkout_drafts
  add column if not exists stripe_request_data jsonb,
  add column if not exists stripe_request_expires_at timestamptz,
  add column if not exists reconciliation_expires_at timestamptz
    not null default (now() + interval '30 days');

alter table private.private_support_checkout_drafts
  drop constraint if exists private_support_checkout_stripe_request_complete,
  add constraint private_support_checkout_stripe_request_complete
    check (
      (stripe_request_data is null and stripe_request_expires_at is null)
      or (
        jsonb_typeof(stripe_request_data) = 'object'
        and octet_length(stripe_request_data::text) <= 8192
        and stripe_request_expires_at is not null
        and stripe_request_expires_at >= created_at + interval '30 minutes'
        and stripe_request_expires_at <= created_at + interval '24 hours'
      )
    ),
  drop constraint if exists private_support_checkout_reconciliation_expiry_order,
  add constraint private_support_checkout_reconciliation_expiry_order
    check (reconciliation_expires_at >= expires_at);

create index if not exists private_support_checkout_drafts_reconciliation_idx
  on private.private_support_checkout_drafts (reconciliation_expires_at);

-- Remove the v1 claim RPC so no caller can use its earlier cleanup and
-- non-persisted request-parameter behaviour after this migration.
drop function if exists public.claim_private_support_checkout_draft(
  uuid, text, jsonb, text, text, smallint, integer, text, text
);
drop function if exists private.claim_private_support_checkout_draft(
  uuid, text, jsonb, text, text, smallint, integer, text, text
);

create or replace function private.claim_private_support_checkout_draft_v2(
  p_client_request_id uuid,
  p_payload_hash text,
  p_booking_data jsonb,
  p_package_key text,
  p_package_name text,
  p_session_count smallint,
  p_total_amount_cents integer,
  p_currency text,
  p_stripe_price_id text,
  p_stripe_request_data jsonb,
  p_stripe_request_expires_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  draft private.private_support_checkout_drafts%rowtype;
begin
  if p_stripe_request_data is null
     or jsonb_typeof(p_stripe_request_data) is distinct from 'object'
     or octet_length(p_stripe_request_data::text) > 8192
     or p_stripe_request_expires_at is null
     or p_stripe_request_expires_at < now() + interval '30 minutes'
     or p_stripe_request_expires_at > now() + interval '24 hours' then
    raise exception 'Invalid persisted Stripe request parameters';
  end if;

  delete from private.private_support_checkout_drafts
    where reconciliation_expires_at <= now();

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
    stripe_request_data,
    stripe_request_expires_at,
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
    p_stripe_request_data,
    p_stripe_request_expires_at,
    now() + interval '2 minutes'
  )
  on conflict (client_request_id) do nothing
  returning * into draft;

  if draft.id is not null then
    return jsonb_build_object(
      'outcome', 'claimed',
      'reference', draft.opaque_reference,
      'claimCount', draft.claim_count,
      'stripeRequestData', draft.stripe_request_data,
      'requestExpiresAt', draft.stripe_request_expires_at
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

  if draft.stripe_request_data is null
     or draft.stripe_request_expires_at is null
     or draft.stripe_request_expires_at < now() + interval '30 minutes' then
    update private.private_support_checkout_drafts
      set status = 'expired', lease_expires_at = null
      where id = draft.id;
    return jsonb_build_object('outcome', 'expired');
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
    'claimCount', draft.claim_count,
    'stripeRequestData', draft.stripe_request_data,
    'requestExpiresAt', draft.stripe_request_expires_at
  );
end;
$$;

revoke all on function private.claim_private_support_checkout_draft_v2(
  uuid, text, jsonb, text, text, smallint, integer, text, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function private.claim_private_support_checkout_draft_v2(
  uuid, text, jsonb, text, text, smallint, integer, text, text, jsonb, timestamptz
) to service_role;

create or replace function public.claim_private_support_checkout_draft_v2(
  p_client_request_id uuid,
  p_payload_hash text,
  p_booking_data jsonb,
  p_package_key text,
  p_package_name text,
  p_session_count smallint,
  p_total_amount_cents integer,
  p_currency text,
  p_stripe_price_id text,
  p_stripe_request_data jsonb,
  p_stripe_request_expires_at timestamptz
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.claim_private_support_checkout_draft_v2(
    p_client_request_id,
    p_payload_hash,
    p_booking_data,
    p_package_key,
    p_package_name,
    p_session_count,
    p_total_amount_cents,
    p_currency,
    p_stripe_price_id,
    p_stripe_request_data,
    p_stripe_request_expires_at
  );
$$;

revoke all on function public.claim_private_support_checkout_draft_v2(
  uuid, text, jsonb, text, text, smallint, integer, text, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.claim_private_support_checkout_draft_v2(
  uuid, text, jsonb, text, text, smallint, integer, text, text, jsonb, timestamptz
) to service_role;

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
    where reconciliation_expires_at <= now();
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function private.cleanup_private_support_checkout_drafts()
  from public, anon, authenticated;
grant execute on function private.cleanup_private_support_checkout_drafts()
  to service_role;

notify pgrst, 'reload schema';
