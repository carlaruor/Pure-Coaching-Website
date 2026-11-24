# Secure form submission deployment

The implementation is intentionally **inactive** in the public website configuration. The reviewed production Function URL and public Turnstile site key are configured, but `enabled` remains `false` and `documentUploadsEnabled` remains `false`. Review the Edge Function, SQL migration, data-handling process and retention policy before enabling it.

`supabase/config.toml` deliberately contains only a non-secret local project identifier. Select the remote project explicitly through `supabase link --project-ref ...` or by opening the intended project in the Dashboard; never infer the deployment target from the repository name.

## Architecture

- `get-started.js` sends one multipart request to `submit-form` only when `form-submission-config.js` is explicitly enabled.
- Document fields are controlled independently by `documentUploadsEnabled`. The Edge Function separately defaults uploads to disabled unless `DOCUMENT_UPLOADS_ENABLED` is exactly `true`.
- The browser receives no Supabase key and no Resend key.
- The Edge Function verifies the request origin, Cloudflare Turnstile, field rules, attachment rules and database-backed rate limits.
- Valid records are stored in `form_submissions`; files retain private submission/category folders and use sanitised participant names, a Queensland timestamp, document type and server-generated unique identifier.
- The database stores private bucket/path references, not public URLs.
- Resend receives one staff notification per stored submission. Documents are never attached and no document URL is placed in email.
- A failed notification leaves the database submission intact with `email_status = 'failed'`.
- Client submission identifiers are single-use idempotency claims. A repeated or concurrent claim receives `409` after validation, Turnstile and rate limiting; it never receives data about the stored submission.

## 1. Security review before deployment

1. Confirm `form_submissions` uses a compatible generated `id` and that `email_status` accepts `pending`, `sent` and `failed`.
2. Confirm RLS is enabled and there are no policies granting `anon` or `authenticated` access to submissions.
3. Confirm `private` is **not** listed under the Data API's exposed schemas. PostgREST calls the service-role-only `public.enforce_form_submission_rate_limit` wrapper, which delegates to `private.check_form_submission_rate_limit` using invoker privileges.
4. Confirm `referral-documents` is private. The migration adds a restrictive policy that denies `anon` and `authenticated` roles every direct operation on objects in that bucket, even if a broader permissive policy exists.
5. Decide who is authorised to view NDIS documents and document that approval process.
6. Publish a real privacy policy and retention notice before collecting participant information.
7. Choose a retention period. Use a scheduled, audited server-side process to delete expired Storage objects and their database references. Do not delete from the browser.
8. Review Australian Privacy Principles and applicable NDIS privacy/security obligations with the organisation's adviser.
9. Apply `20261117010000_harden_form_submission_delivery.sql` before deploying the Function. It adds non-destructive notification-attempt metadata required by the reviewed code.

### Production activation blockers

Do not set `enabled: true` until all of these are complete:

1. Confirm the configured public Turnstile site key matches the reviewed Cloudflare widget. Do not replace it with a test key in production.
2. Configure that widget for the exact hostname `carlaruor.github.io` and keep its secret only in the Edge Function secret store.
3. Confirm `ALLOWED_ORIGINS` includes the exact origin `https://carlaruor.github.io`. Origins never include `/Pure-Coaching-Website/`.
4. Obtain business and appropriate legal/privacy approval for `privacy-policy.html`, then publish it. The page is visibly marked as a draft and the public intake must remain disabled until the draft notice and its operational commitments have been approved.
5. Approve a documented retention period and implement a scheduled, audited server-side deletion process covering both database rows and private Storage objects. No retention worker currently exists.
6. Implement and verify a malware-scanning/quarantine workflow before staff download uploaded documents, or keep document collection disabled until one exists. Current signature/container validation is not malware scanning.
7. Approve the staff access process for private files, including least privilege, access logging, incident response and secure deletion. Do not place signed or public links in email.
8. Redeploy the reviewed Edge Function from this branch, run the rejection tests, and complete one synthetic end-to-end test from the GitHub Pages origin. Reconfirm one database row, private object references and exactly one staff notification.

## 2. Apply database controls

Link the Supabase CLI to the intended project, inspect the migration, then apply it:

```sh
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

The migration enables RLS, revokes browser roles, adds an idempotency index and creates a private rate-limit table. The rate-limit implementation remains in the non-exposed `private` schema; only its service-role-only wrapper is available through PostgREST. The migration also forces the required bucket to private, installs a restrictive deny policy for browser roles, and refuses to complete if the bucket does not exist. It does not delete or rewrite existing form submissions or Storage objects.

The follow-up hardening migration adds `email_attempt_count`, `email_last_attempt_at`, `email_provider_id` and `email_retryable`, plus a bounded-attempt constraint and failed-delivery index. It does not delete submissions or change the existing required columns.

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

For GitHub Pages, configure the widget hostname as `carlaruor.github.io`. Cloudflare hostname configuration does not include the repository path.

## 4. Set Edge Function secrets

Set these values with placeholders replaced locally. Never commit the resulting command, shell history containing real values, or an environment file.

```sh
supabase secrets set \
  RESEND_API_KEY=YOUR_RESEND_API_KEY \
  TURNSTILE_SECRET_KEY=YOUR_TURNSTILE_SECRET \
  RATE_LIMIT_SALT=AT_LEAST_32_RANDOM_CHARACTERS \
  RATE_LIMIT_ENABLED=true \
  ALLOWED_ORIGINS=https://carlaruor.github.io \
  DOCUMENT_UPLOADS_ENABLED=false
```

`SUPABASE_URL` and `SUPABASE_SECRET_KEYS` are supplied to deployed Edge Functions by Supabase and do not need to be added manually. The Function reads the `default` server secret from that injected JSON map. Neither value may ever be copied into frontend JavaScript. The reviewed sender and recipient are fixed in server code as `Pure Coaching Website <notifications@pure-coaching.com.au>` and `info@pure-coaching.com.au`. Add both the custom domain and GitHub Pages origin to `ALLOWED_ORIGINS` only if both genuinely serve the form; separate multiple origins with commas and do not use `*`.

`RATE_LIMIT_ENABLED` is fail-closed: only the exact value `false` bypasses the existing IP and email submission limits. Set it to `true` for normal production enforcement. Missing, empty or invalid values continue to enforce rate limiting. Turnstile, validation and duplicate-submission protection remain active regardless of this setting.

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
- attachment-free submissions while document uploads are disabled;
- direct multipart file rejection while document uploads are disabled;
- restored document validation and private upload behaviour when both upload controls are enabled;
- one staff email only and no applicant email;
- no document content, filename or link in the email;
- keyboard/screen-reader form behaviour.

Use synthetic documents only. Never place participant data in fixtures, logs or the repository.

When Deno is available, run the committed unit tests before any deployment:

```sh
deno test --allow-env supabase/functions/submit-form/index_test.ts
```

The tests cover the deployed secret-key dictionary, trusted-IP selection, validation-before-idempotency, DOCX container checks, misleading ZIP rejection and cleanup failure preservation. A separate opt-in integration test covers rejection and a two-request concurrency race. Run it only against an approved local/staging Function using Turnstile test credentials and synthetic data:

```sh
TEST_SUBMIT_FORM_URL=https://STAGING_FUNCTION_URL \
TEST_ALLOWED_ORIGIN=https://APPROVED_TEST_ORIGIN \
TEST_TURNSTILE_TOKEN=TURNSTILE_TEST_TOKEN \
deno test --allow-env --allow-net supabase/functions/submit-form/integration_test.ts
```

After the concurrency test, confirm exactly one row exists for the synthetic client ID, there is no second email attempt, and the losing response is `409` without a database submission ID. Delete the synthetic row through an authorised administrative workflow.

### Request size and document validation

The Function requires a gateway-provided numeric `Content-Length` and rejects multipart requests above 36 MiB before parsing. The accepted files remain capped at 10 MiB each and 35 MiB combined. This is bounded well below Supabase Edge Functions' current 256 MB memory limit, but multipart parsing still holds request data in memory; test the maximum permitted request in staging and monitor memory/resource errors before activation.

DOCX validation now inspects the ZIP central directory without decompressing the complete archive. It requires the core DOCX entries, verifies their local headers, rejects encrypted/ZIP64/unsafe paths, caps entry count and expanded size/compression ratio, and rejects common macro/ActiveX/embedded-object entries. This is format validation, not malware scanning. A managed malware-scanning/quarantine workflow remains required before staff download participant documents.

### Trusted client address

On hosted Supabase Edge Functions, rate limiting uses only the `cf-connecting-ip` value supplied by the Supabase/Cloudflare gateway. Caller-supplied `X-Forwarded-For` is ignored. If the trusted gateway value is missing or malformed, requests share the conservative `gateway-ip-unavailable` bucket while the independent email limit and Turnstile still apply. Confirm the hosted gateway overwrites `cf-connecting-ip` during staging tests; do not deploy this Function behind an unreviewed proxy that forwards a client-controlled value.

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

1. Open the correct project and confirm the five custom secrets are present by **name only**, including `DOCUMENT_UPLOADS_ENABLED`. Do not reveal or copy their values.
2. Choose **Edge Functions → Deploy a new function → Via Editor** and name it exactly `submit-form`.
3. Replace the generated source with the **entire contents** of `supabase/functions/submit-form/index.ts` from this branch. Paste it as plain TypeScript with no Markdown fences, wrappers or test files. The final line must remain `export default { fetch: handleRequest };`; this is the current Dashboard-compatible module entrypoint.
4. Use the editor's built-in type check and stop if it reports any error.
5. Deploy the function, then open its detail/settings page and turn **JWT verification off**. The browser form is unauthenticated; the Function performs origin, Turnstile, rate-limit and validation checks itself.
6. Keep `form-submission-config.js` unchanged with `enabled: false`, `documentUploadsEnabled: false`, the reviewed production endpoint and the existing public Turnstile site key.
7. Run rejection tests first: disallowed origin, missing Turnstile token, malformed payload and direct anonymous Storage access must all fail.
8. For the one successful end-to-end test, use a private, temporary test harness on an allowed test origin with a valid Turnstile widget and synthetic names, contact details and documents only. Do not commit that harness or its public test configuration.
9. Confirm one database row, only private Storage references, the rate-limit counters, and exactly one notification to Pure Coaching. Delete the synthetic submission and documents using an authorised administrative process after recording the test result.

The Dashboard route is suitable here because the Function has one source file and the Dashboard editor provides Deno/Supabase type checking. CLI deployment remains preferable for repeatability because it applies the tracked `config.toml` automatically; with the Dashboard route, the JWT setting must be checked manually.

For the single controlled browser-to-database-to-Storage-to-Resend verification, follow `docs/single-intake-integration-test.md`. It keeps the committed public configuration disabled and activates the real form only in a session-scoped local preview.

## 7. Activate the frontend last

After deployment, policy/retention/file-handling approval and security testing, edit only the public values in `form-submission-config.js`:

```js
window.PURE_FORM_SUBMISSION_CONFIG = Object.freeze({
  enabled: true,
  documentUploadsEnabled: false,
  endpoint: 'https://ovsedudlfslldvhmswjy.supabase.co/functions/v1/submit-form',
  turnstileSiteKey: 'YOUR_EXISTING_PUBLIC_TURNSTILE_SITE_KEY'
});
```

Deploy the static site and perform a final synthetic submission. Confirm the database record, private object paths, exactly one Resend notification and no applicant email.

### Re-enable document uploads after security approval

Document uploads remain disabled independently of general form submissions. Reactivation requires both controls:

1. Set `documentUploadsEnabled: true` in `form-submission-config.js` and publish the website.
2. Set the Supabase Edge Function secret `DOCUMENT_UPLOADS_ENABLED=true`.

No Edge Function source change or redeployment is required, provided the deployed Function includes the environment-based control from this branch. The Function reads the current environment value for every request. If either control remains disabled, the browser omits document fields or the server safely rejects direct file uploads. Do not enable either control until the approved quarantine, malware-scanning, staff-access and retention procedures are operational.

### GitHub Pages repository path

The page is served at `https://carlaruor.github.io/Pure-Coaching-Website/get-started.html`. Its scripts and internal navigation use relative URLs, while the Edge Function and Turnstile script use absolute HTTPS URLs, so the `/Pure-Coaching-Website/` base path is preserved. The Function CORS check receives only `https://carlaruor.github.io` as the browser origin. Do not add the repository path to `ALLOWED_ORIGINS`.

The localhost `sessionStorage` preview remains available only when the hostname is `localhost`, `127.0.0.1` or `::1` and `?form-preview=1` is present. Production configuration does not read or depend on that preview value.

## Private document access

Do not create public URLs. A future staff-only admin service should authenticate and authorise the staff member, log the access, and generate a very short-lived signed URL only when needed. Signed URLs must not be placed in notification emails. Until that workflow exists, documents should be accessed only by specifically authorised administrators through the Supabase Dashboard.

## Operational notes

- The public Function makes exactly one Resend attempt after Storage is finalised and uses the stable key `pure-form/<submission-id>`. Resend currently retains idempotency keys for 24 hours.
- A future authenticated server-side recovery worker may claim only `email_status = 'failed'`, `email_retryable = true` rows with `email_attempt_count < 3`, atomically increment the count, and retry with the same key and identical payload. Allow at most two retries, serialize claims, and keep them within 23 hours of the first attempt. On success, store the provider ID and mark `sent`; on a definite failure, return to `failed`. For an ambiguous result outside the idempotency window, staff must reconcile against Resend before any resend. Never expose recovery through the public form endpoint.
- The recovery worker is not implemented yet. Until it is reviewed, failed notifications require manual reconciliation and must not be resent automatically.
- If upload cleanup cannot be verified, the Function preserves the database row with `pending` private paths and logs only its submission ID. An authorised administrator must compare those paths with Storage, remove any remaining objects, and then remove the incomplete row. Never delete the recovery record before Storage cleanup is confirmed.
- Edge Function logs intentionally contain only submission IDs and error categories. Never add payloads, email addresses, health information or filenames to logs. Original filenames are intentionally not retained in Storage paths or attachment metadata.
- Rotate the Resend key, Turnstile secret, rate-limit salt and service-role key after any suspected exposure.
