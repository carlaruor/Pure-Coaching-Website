# Private Support purchases schema

## Scope

Migration `supabase/migrations/20261124000000_private_support_purchases.sql` prepares secure database storage for future Private Support package purchases. It does not connect Stripe, enable the disabled booking button, submit the optional questionnaire, send email, or change the frontend.

Migration `supabase/migrations/20261127000000_private_support_checkout_drafts.sql` separately prepares short-lived, private booking drafts used while a Stripe-hosted Checkout Session is open. Drafts are not purchases. See `docs/private-support-checkout-deployment.md` for the security model, deployment order and cleanup procedure.

Purchases remain separate from `form_submissions` and `employment_applications`. No customer table is introduced, and card details must never be stored in this table.

## Current booking model

The current Private Support page offers these packages:

| Package | Sessions | Amount |
| --- | ---: | ---: |
| 5 Sessions | 5 | AUD 250.00 |
| 10 Sessions | 10 | AUD 500.00 |
| 15 Sessions | 15 | AUD 750.00 |

The booking interface currently collects purchaser first name, last name, email and phone, plus preferred days, preferred time of day and optional scheduling notes. The future payment service must resolve the selected package against a server-controlled catalogue and write the trusted session count and amount in cents; it must not trust price values supplied by the browser.

The separate optional questionnaire currently contains who the sessions are for, an optional participant name, personal goals, interests and preferred activities, and support preferences. A future authenticated flow can store that payload in `questionnaire_data` and set `questionnaire_completed_at` on the corresponding verified purchase.

## Table design

`public.private_support_purchases` contains:

- generated UUID identity plus creation and automatically maintained update timestamps;
- purchaser contact details;
- package name, session count, integer amount in cents and three-letter currency (default `AUD`);
- payment state and nullable unique Stripe Checkout Session and Payment Intent identifiers;
- payment confirmation timestamp with state consistency checks;
- JSON object fields for booking and optional completed questionnaire data;
- bounded email-delivery tracking consistent with the existing submission tables.

Allowed payment states are `pending`, `processing`, `paid`, `failed`, `cancelled`, `refunded` and `partially_refunded`. The database requires a payment confirmation timestamp for paid or refunded states and prohibits one for incomplete or failed states.

The table has indexes for creation time, payment workflow, purchaser email, paid purchases awaiting questionnaires, and retryable failed emails. Nullable Stripe identifiers are protected by unique constraints.

## Security

Row Level Security is enabled. `public`, `anon` and `authenticated` receive no table privileges; `service_role` is the only application role granted table access. No permissive RLS policies are created. Future Stripe webhook, purchase and questionnaire code must run in trusted server-side functions and must never expose the service-role credential to the browser.

The schema stores Stripe references only. It must never store card numbers, security codes, expiry dates or other card details.

## Manual review and application

This migration is not executed automatically by the website. Before applying it:

1. Review the package catalogue, payment states and retention requirements with the business.
2. Confirm the preceding migrations have created the `private` schema and that `gen_random_uuid()` is available in the Supabase project.
3. Review the SQL in the Supabase SQL editor, then apply it to the intended project.
4. Confirm RLS is enabled and `anon` and `authenticated` cannot select, insert, update or delete rows.
5. Confirm `service_role` can manage rows through a controlled server-side test using synthetic data only.
6. Confirm `updated_at` changes during an update and all unique/check constraints reject invalid synthetic records.

For rollback before any production integration, remove the trigger, table and dedicated trigger function after confirming that no purchase records need preservation. Once purchases exist, treat rollback as a data migration and export or retain required business records before any destructive action.
