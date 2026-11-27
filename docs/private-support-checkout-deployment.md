# Private Support Stripe Checkout preparation

## Status and scope

The `create-checkout-session` Edge Function prepares a Stripe-hosted, one-time Checkout Session for the existing Private Support booking fields. It is intentionally disconnected from the public booking button, which remains disabled. This implementation does not verify payments, create `private_support_purchases`, send notifications, submit questionnaires or fulfil sessions.

Do not enable real customer checkout until a separately reviewed Stripe webhook verifies signed events and atomically creates the purchase record. A success-page redirect is not proof of payment.

## Server-controlled catalogue

| Package key | Sessions | Trusted amount | Required Stripe secret |
| --- | ---: | ---: | --- |
| `5-sessions` | 5 | AUD 250.00 | `STRIPE_PRICE_5_SESSIONS` |
| `10-sessions` | 10 | AUD 500.00 | `STRIPE_PRICE_10_SESSIONS` |
| `15-sessions` | 15 | AUD 750.00 | `STRIPE_PRICE_15_SESSIONS` |

The function retrieves the configured Price from Stripe and verifies that it is active, one-time, Australian dollars, has the expected integer amount and belongs to the configured test/live environment. Browser-supplied labels, prices and Price IDs are not used.

## Request contract

The future frontend may send only JSON matching this shape:

```json
{
  "clientRequestId": "client-generated-random-uuid-v4",
  "packageKey": "5-sessions",
  "purchaser": {
    "firstName": "Synthetic",
    "lastName": "Customer",
    "email": "synthetic@example.invalid",
    "phone": "0400 000 000"
  },
  "booking": {
    "days": ["Mon", "Wed"],
    "time": "I'm flexible",
    "notes": "Synthetic scheduling note"
  },
  "turnstileToken": "single-use-token-for-action-private_checkout"
}
```

The body is limited to 16 KiB. The function validates and canonicalises every field before storing a draft or calling Stripe. The only Stripe metadata is an opaque server-generated checkout reference; purchaser details, availability, notes, health information and disability information must never be copied into Stripe metadata.

## Required migration

Review and manually apply, in order:

1. `supabase/migrations/20261124000000_private_support_purchases.sql`
2. `supabase/migrations/20261127000000_private_support_checkout_drafts.sql`
3. `supabase/migrations/20261127010000_harden_private_support_checkout_drafts.sql`

The second migration creates `private.private_support_checkout_drafts`, enables RLS, revokes `public`, `anon` and `authenticated` access, and grants access only to `service_role`. The public-schema RPC wrappers exist only because the private schema is not exposed through PostgREST; execution is revoked from browser roles.

The original draft migration has already been applied. Apply the incremental migration `supabase/migrations/20261127010000_harden_private_support_checkout_drafts.sql` before deploying this function revision. It stores the exact Stripe request inputs and requested expiry used by the first attempt, replaces the claim RPC with `claim_private_support_checkout_draft_v2`, and introduces a separate 30-day reconciliation expiry.

A draft stops being operational after 48 hours, but its private data and opaque Stripe association are retained for no more than 30 days for delayed webhook delivery or authorised manual replay. Cleanup removes rows only after that reconciliation deadline. This protects the future webhook from losing booking context when a payment event is delayed. The future webhook must create the durable purchase atomically and mark the draft completed; it must also be idempotent by Stripe event and Checkout Session identifiers. The 30-day period and the eventual purchase-retention policy require business/privacy approval.

After approval, schedule this statement hourly with Supabase Cron so cleanup does not depend on new traffic:

```sql
select public.cleanup_private_support_checkout_drafts();
```

The future payment webhook must use the opaque reference, verify the Stripe signature and paid state, insert the trusted purchase atomically, and then mark the corresponding draft completed. Retention and business-record obligations must be approved before changing either the 48-hour operational expiry or 30-day reconciliation expiry.

## Required Edge Function configuration

Configure secrets in the intended Supabase project without writing values to the repository:

- `ALLOWED_ORIGINS`: exact comma-separated website origins, never `*`.
- `TURNSTILE_SECRET_KEY`: existing private Turnstile secret.
- `RATE_LIMIT_SALT`: existing random server-side salt.
- `SUPABASE_SECRET_KEYS`: Supabase-injected secret-key JSON used by the existing function pattern.
- `PRIVATE_CHECKOUT_ENABLED`: keep `false` until sandbox review is complete.
- `STRIPE_CHECKOUT_ENVIRONMENT`: `test` for sandbox review; later `live` only after webhook approval.
- `PRIVATE_CHECKOUT_TESTER_TOKEN`: at least 32 random bytes, stored only as an Edge Function secret and supplied out-of-band to authorised sandbox testers. Never place it in frontend code.
- `STRIPE_SECRET_KEY`: matching `sk_test_...` or `sk_live_...` server secret.
- `STRIPE_PRICE_5_SESSIONS`, `STRIPE_PRICE_10_SESSIONS`, `STRIPE_PRICE_15_SESSIONS`: matching one-time Stripe Price IDs.
- `PRIVATE_CHECKOUT_SUCCESS_URL`: trusted HTTPS URL containing the literal `{CHECKOUT_SESSION_ID}` placeholder.
- `PRIVATE_CHECKOUT_CANCEL_URL`: trusted HTTPS cancellation URL.

The success and cancellation URL origins must also appear in `ALLOWED_ORIGINS`. Local HTTP URLs are accepted only for `localhost`, `127.0.0.1` or `::1` while the environment is `test`.

Checkout rate limiting is always active and does not use the general form `RATE_LIMIT_ENABLED` switch. The email limit is always applied. The IP limit is applied only when the hosted Supabase environment provides a valid `cf-connecting-ip`; a missing header does not place every visitor into a shared global bucket. Supabase documents this header as platform-populated. Confirm its presence in `function_edge_logs` during the controlled deployment test without logging the address in application logs.

In test mode, the function also requires the server-only tester token in the `X-Private-Checkout-Token` request header. CORS and Turnstile remain required but are not treated as tester authorisation. The public website must never contain this token, and the public payment button remains disabled.

## Safe sandbox deployment procedure

This branch does not deploy the function or enable checkout. After review and explicit approval:

1. Create three one-time Stripe **test-mode** Prices in AUD for exactly 25000, 50000 and 75000 cents.
2. Confirm the original draft migration is present, then apply the incremental hardening migration to the intended Supabase project.
3. Confirm the draft table is in the non-exposed `private` schema and browser roles cannot execute any checkout-draft RPC.
4. Configure only test-mode Stripe secrets, a high-entropy tester token, trusted staging URLs and `PRIVATE_CHECKOUT_ENABLED=false`.
5. Deploy with `supabase functions deploy create-checkout-session --no-verify-jwt`. JWT verification is disabled because the public endpoint uses strict origin checks, Turnstile, rate limits and server-side validation.
6. Configure the Turnstile widget for the action `private_checkout` in a non-public test harness. Send the tester token from a controlled test client, never from committed or browser-delivered code.
7. Change `PRIVATE_CHECKOUT_ENABLED=true` only for a controlled synthetic sandbox test, then return it to `false`.
8. Verify duplicate requests return the same unexpired Checkout URL and concurrent requests do not create multiple Sessions. Simulate an ambiguous provider timeout and confirm the retry reuses the identical body, `expires_at` and idempotency key.
9. Verify the private draft expires and cleanup removes it. Confirm that `private_support_purchases` remains empty because no webhook exists.

Do not connect or enable the public booking button during this procedure.

## Security and launch blockers

- A signed Stripe webhook and replay-safe payment verification are mandatory before real payments or purchase fulfilment.
- The success page must not claim a verified purchase until it obtains server-verified payment state from the future webhook flow.
- Stripe test and live keys, Prices and redirect URLs must remain isolated. The function rejects a key or Price whose mode does not match `STRIPE_CHECKOUT_ENVIRONMENT`.
- Trusted proxy behaviour for `cf-connecting-ip` should be confirmed in the deployed Supabase environment. If unavailable, the email limit still applies and no shared fallback IP bucket is created.
- Turnstile hostname/action validation requires the future widget to issue tokens for `private_checkout`.
- Stripe receives the purchaser email to prefill Checkout. Overseas processing and the final privacy wording require business approval before launch.
- The package catalogue, GST/tax treatment, cancellation/refund terms and advertised amounts require business approval.
- Temporary-draft cleanup must be scheduled and monitored. Operational access to private booking drafts should be limited and audited. Delayed payment events must be reconciled before the 30-day deadline.
- Stripe API v1 caches the first result for an idempotency key, including some `500` responses. Identical retries prevent duplicates but might not recover a cached provider error. After the bounded retry count, an authorised operator must reconcile the opaque reference in Stripe before permitting a new checkout; the future webhook should automate this recovery path.
- `STRIPE_API_VERSION` is pinned to `2026-11-18.endive`, the current Stripe API version verified during this review. The future webhook endpoint should use a compatible pinned version, and the pin must be reviewed before production deployment.
- Supabase currently injects `SUPABASE_SECRET_KEYS` as a JSON dictionary and the function correctly reads its `default` value. Do not create a custom secret with a `SUPABASE_` prefix; that namespace is platform-reserved.
