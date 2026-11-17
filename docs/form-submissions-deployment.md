# Secure form submission deployment

The implementation is intentionally **inactive** in the public website configuration. Review the Edge Function, SQL migration, data-handling process and retention policy before enabling it.

`supabase/config.toml` deliberately contains only a non-secret local project identifier. Select the remote project explicitly through `supabase link --project-ref ...` or by opening the intended project in the Dashboard; never infer the deployment target from the repository name.

## Architecture

- `get-started.js` sends one multipart request to `submit-form` only when `form-submission-config.js` is explicitly enabled.
- The browser receives no Supabase key and no Resend key.
- The Edge Function verifies the request origin, Cloudflare Turnstile, field rules, attachment rules and database-backed rate limits.
- Valid records are stored in `form_submissions`; files are stored under unpredictable paths in the private `referral-documents` bucket.
- The database stores private bucket/path references, not public URLs.
- Resend receives one staff notification per stored submission. Documents are never attached and no document URL is placed in email.
- A failed notification leaves the database submission intact with `email_status = 'failed'`.

## 1. Security review before deployment

1. Confirm `form_submissions` uses a compatible generated `id` and that `email_status` accepts `pending`, `sent` and `failed`.
2. Confirm RLS is enabled and there are no policies granting `anon` or `authenticated` access to submissions.
3. Confirm `private` is **not** listed under the Data API's exposed schemas. PostgREST calls the service-role-only `public.enforce_form_submission_rate_limit` wrapper, which delegates to `private.check_form_submission_rate_limit` using invoker privileges.
4. Confirm `referral-documents` is private. The migration adds a restrictive policy that denies `anon` and `authenticated` roles every direct operation on objects in that bucket, even if a broader permissive policy exists.
5. Decide who is authorised to view NDIS documents and document that approval process.
6. Publish a real privacy policy and retention notice before collecting participant information.
7. Choose a retention period. Use a scheduled, audited server-side process to delete expired Storage objects and their database references. Do not delete from the browser.
8. Review Australian Privacy Principles and applicable NDIS privacy/security obligations with the organisation's adviser.

## 2. Apply database controls

Link the Supabase CLI to the intended project, inspect the migration, then apply it:

```sh
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

The migration enables RLS, revokes browser roles, adds an idempotency index and creates a private rate-limit table. The rate-limit implementation remains in the non-exposed `private` schema; only its service-role-only wrapper is available through PostgREST. The migration also forces the required bucket to private, installs a restrictive deny policy for browser roles, and refuses to complete if the bucket does not exist. It does not delete or rewrite existing form submissions or Storage objects.

After applying the migration, verify the controls in the SQL editor:

```sql
select id, public from storage.buckets where id = 'referral-documents';

select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
  and policyname = 'Block direct access to referral documents';

select
  has_function_privilege('anon', 'public.enforce_form_submission_rate_limit(text, integer, integer)', 'execute') as anon_can_execute,
  has_function_privilege('authenticated', 'public.enforce_form_submission_rate_limit(text, integer, integer)', 'execute') as authenticated_can_execute,
  has_function_privilege('service_role', 'public.enforce_form_submission_rate_limit(text, integer, integer)', 'execute') as service_role_can_execute;
```

Expected results: the bucket is not public, the policy is restrictive, both browser roles return `false`, and `service_role` returns `true`.

## 3. Configure anti-spam protection

Create a Cloudflare Turnstile widget for the exact production hostname. Keep its secret server-side. The site key is public and will later be placed in the browser configuration.

## 4. Set Edge Function secrets

Set these values with placeholders replaced locally. Never commit the resulting command, shell history containing real values, or an environment file.

```sh
supabase secrets set \
  RESEND_API_KEY=YOUR_RESEND_API_KEY \
  TURNSTILE_SECRET_KEY=YOUR_TURNSTILE_SECRET \
  RATE_LIMIT_SALT=AT_LEAST_32_RANDOM_CHARACTERS \
  ALLOWED_ORIGINS=https://YOUR_GITHUB_PAGES_ORIGIN
```

`SUPABASE_URL` and `SUPABASE_SECRET_KEYS` are supplied to deployed Edge Functions by Supabase and do not need to be added manually. The Function reads the `default` server secret from that injected JSON map. Neither value may ever be copied into frontend JavaScript. The reviewed sender and recipient are fixed in server code as `Pure Coaching Website <notifications@pure-coaching.com.au>` and `info@pure-coaching.com.au`. Add both the custom domain and GitHub Pages origin to `ALLOWED_ORIGINS` only if both genuinely serve the form; separate multiple origins with commas and do not use `*`.

## 5. Local review and testing

Copy `supabase/functions/.env.example` to an ignored `.env.local`, use only non-production test data, and run:

```sh
supabase functions serve submit-form --env-file supabase/functions/.env.local --no-verify-jwt
```

Test at minimum:

- allowed and rejected origins;
- missing/invalid Turnstile tokens;
- every conditional field path;
- invalid extensions, MIME types, signatures, sizes and file counts;
- duplicate submission IDs;
- IP/email rate limits;
- database failure, upload failure and Resend failure cleanup/status;
- one staff email only and no applicant email;
- no document content, filename or link in the email;
- keyboard/screen-reader form behaviour.

Use synthetic documents only. Never place participant data in fixtures, logs or the repository.

### Verify the rate-limit RPC before Function deployment

Run this transaction in the Supabase SQL editor. It uses an obviously synthetic hash and rolls back all counter changes:

```sql
begin;
set local role service_role;

select public.enforce_form_submission_rate_limit(
  repeat('a', 64),
  2,
  60
) as first_attempt_allowed;

select public.enforce_form_submission_rate_limit(
  repeat('a', 64),
  2,
  60
) as second_attempt_allowed;

select public.enforce_form_submission_rate_limit(
  repeat('a', 64),
  2,
  60
) as third_attempt_blocked;

rollback;
```

Expected values are `true`, `true`, then `false`. Also repeat the privilege queries from section 2; do not test with a real email address or IP hash.

### Verify private Storage access

Before sending any Function request, use a synthetic document with no personal information and verify through the Storage API that:

1. the anonymous/publishable browser role cannot list the bucket;
2. it cannot download a known synthetic object path;
3. direct upload, update and delete requests are denied;
4. the same synthetic file can be uploaded by the Edge Function's injected server secret;
5. no public URL serves the object.

Delete the synthetic object through an authorised server/Dashboard workflow after the test. Never relax the restrictive policy to make testing easier.

## 6. Deploy for reviewed testing

Only after the controls above pass review:

```sh
supabase functions deploy submit-form --no-verify-jwt
```

The function is intentionally unauthenticated at the Supabase gateway because the public form has no user account. Origin restrictions, Turnstile, database rate limits and strict validation are enforced inside the function.

### Safest alternative when CLI and Deno are unavailable

Use the Supabase Dashboard Edge Function editor only after explicit deployment approval:

1. Open the correct project and confirm the four custom secrets are present by **name only**. Do not reveal or copy their values.
2. Choose **Edge Functions → Deploy a new function → Via Editor** and name it exactly `submit-form`.
3. Replace the generated source with the reviewed `supabase/functions/submit-form/index.ts` from this branch.
4. Use the editor's built-in type check and stop if it reports any error.
5. Deploy the function, then open its detail/settings page and turn **JWT verification off**. The browser form is unauthenticated; the Function performs origin, Turnstile, rate-limit and validation checks itself.
6. Keep `form-submission-config.js` unchanged with `enabled: false`, an empty endpoint and an empty Turnstile site key.
7. Run rejection tests first: disallowed origin, missing Turnstile token, malformed payload and direct anonymous Storage access must all fail.
8. For the one successful end-to-end test, use a private, temporary test harness on an allowed test origin with a valid Turnstile widget and synthetic names, contact details and documents only. Do not commit that harness or its public test configuration.
9. Confirm one database row, only private Storage references, the rate-limit counters, and exactly one notification to Pure Coaching. Delete the synthetic submission and documents using an authorised administrative process after recording the test result.

The Dashboard route is suitable here because the Function has one source file and the Dashboard editor provides Deno/Supabase type checking. CLI deployment remains preferable for repeatability because it applies the tracked `config.toml` automatically; with the Dashboard route, the JWT setting must be checked manually.

## 7. Activate the frontend last

After deployment and security testing, edit only the public values in `form-submission-config.js`:

```js
window.PURE_FORM_SUBMISSION_CONFIG = Object.freeze({
  enabled: true,
  endpoint: 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/submit-form',
  turnstileSiteKey: 'YOUR_PUBLIC_TURNSTILE_SITE_KEY'
});
```

Deploy the static site and perform a final synthetic submission. Confirm the database record, private object paths, exactly one Resend notification and no applicant email.

## Private document access

Do not create public URLs. A future staff-only admin service should authenticate and authorise the staff member, log the access, and generate a very short-lived signed URL only when needed. Signed URLs must not be placed in notification emails. Until that workflow exists, documents should be accessed only by specifically authorised administrators through the Supabase Dashboard.

## Operational notes

- Monitor `failed` email statuses and retry manually through an authenticated server-side process. Do not make the public browser retry email delivery.
- Edge Function logs intentionally contain only submission IDs and error categories. Never add payloads, email addresses, health information or filenames to logs. Original filenames are intentionally not retained in Storage paths or attachment metadata.
- Rotate the Resend key, Turnstile secret, rate-limit salt and service-role key after any suspected exposure.
