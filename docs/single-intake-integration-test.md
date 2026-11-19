# Single controlled intake integration test

Run this procedure exactly once against the reviewed, deployed `submit-form` Edge Function. Use only the synthetic values below. Do not use participant, NDIS or health information.

The public form remains disabled by default. The committed preview gate works only on `localhost`, `127.0.0.1` or `::1`, requires `?form-preview=1`, and reads only the public Function endpoint and public Turnstile site key from `sessionStorage`.

## 1. Preflight — stop if any check fails

1. Confirm the deployed Function source matches this branch and ends with:

   ```ts
   export default { fetch: handleRequest };
   ```

2. Confirm JWT verification is disabled for `submit-form` and the secrets `RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`, `RATE_LIMIT_SALT` and `ALLOWED_ORIGINS` exist by name. Never reveal their values.
3. Confirm both migrations have been applied, including `20261117010000_harden_form_submission_delivery.sql`.
4. In the SQL editor, confirm `form_submissions` has `email_attempt_count`, `email_last_attempt_at`, `email_provider_id` and `email_retryable`.
5. Confirm `referral-documents` is private and the browser roles cannot read, list, upload, update or delete its objects directly.
6. Add `http://localhost:8765` to the existing `ALLOWED_ORIGINS` value without removing the production origin.
7. In the existing production Turnstile widget, temporarily allow the hostname `localhost`. Use the real public site key already paired with the configured `TURNSTILE_SECRET_KEY`.
8. In Resend, confirm `pure-coaching.com.au` remains verified and there is no existing message for marker `SYNTHETIC-E2E-20261119-01`.
9. In Supabase, confirm there is no existing row with that marker:

   ```sql
   select count(*)
   from public.form_submissions
   where form_data ->> 'message' =
     'SYNTHETIC-E2E-20261119-01 — controlled integration test only; no participant data.';
   ```

   The result must be `0`. If it is not, stop; do not send another submission.

## 2. Create the synthetic attachment

Create one valid, one-page PDF named `synthetic-e2e-intake.pdf`. Its only text must be:

```text
SYNTHETIC-E2E-20261119-01
Controlled integration test only.
No participant or health information.
```

On macOS, this can be created in TextEdit using **Format → Make Plain Text**, then **File → Print → PDF → Save as PDF**. Store it under the ignored `test-documents/` directory. Do not commit it.

## 3. Start the local preview

From the repository root, run:

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

Open `http://localhost:8765/` and, in that tab's browser console, set only the public preview values:

```js
sessionStorage.setItem('pure-form-submission-preview', JSON.stringify({
  endpoint: 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/submit-form',
  turnstileSiteKey: 'YOUR_PUBLIC_TURNSTILE_SITE_KEY'
}));

location.assign('/get-started.html?support=ndis&intent=enrolment&form-preview=1');
```

Replace only the two placeholders. Do not enter a Supabase secret key, service-role key, Resend key or Turnstile secret in the browser.

After navigation, verify in the console:

```js
window.PURE_FORM_SUBMISSION_CONFIG
```

It must show `enabled: true`, `preview: true`, the expected Function URL and the public Turnstile site key. If not, stop.

## 4. Submit exactly once

Complete the form with these values:

- Contacting for: `Myself`
- First name: `Synthetic`
- Last name: `Integration Test`
- Email: `info@pure-coaching.com.au`
- Phone: `0400 000 000`
- Support: fixed to `NDIS Support`
- NDIS plan: `Yes`
- Funding management: `Plan-managed`
- Primary disability: `Synthetic test — no disability information`
- Secondary disabilities: leave blank
- Age range: `Prefer not to say`
- Message: `SYNTHETIC-E2E-20261119-01 — controlled integration test only; no participant data.`
- Preferred contact: `Email`
- Best contact time: `Either`
- NDIS Plan attachment: `synthetic-e2e-intake.pdf`
- Supporting reports: leave empty
- Consent: checked

Complete the visible Turnstile challenge. This creates a real, short-lived token with action `intake`; never copy it into a file or commit it.

Open the browser Network panel, enable **Preserve log**, and click **Send enquiry** once. Do not double-click, refresh, retry or use the Back button after submission.

Expected browser result:

- one `POST` request to `/functions/v1/submit-form`;
- HTTP `200` with `{ "ok": true }`;
- the existing confirmation panel appears;
- no browser request contains a Supabase secret or Resend key.

If the response is not successful, stop and record only the response status, safe error code and Function execution ID. Do not resubmit with the same marker.

## 5. Verify Supabase

Run:

```sql
select
  id,
  created_at,
  form_type,
  form_data ->> 'clientSubmissionId' as client_submission_id,
  form_data ->> 'message' as test_marker,
  attachments,
  email_status,
  email_sent_at,
  email_attempt_count,
  email_provider_id,
  email_retryable
from public.form_submissions
where form_data ->> 'message' =
  'SYNTHETIC-E2E-20261119-01 — controlled integration test only; no participant data.';
```

Verify all of the following:

- exactly one row exists and `form_type = 'intake'`;
- `client_submission_id` is present;
- `attachments` contains exactly one item;
- that item has bucket `referral-documents`, state `stored`, an unpredictable path, PDF content type and no original filename or public URL;
- `email_status = 'sent'`;
- `email_attempt_count = 1`;
- `email_sent_at` and `email_provider_id` are populated;
- `email_retryable = false`.

Copy only the private object path shown in `attachments`. In Storage, verify that exact object exists in the private `referral-documents` bucket and can be opened only through an authorised Dashboard session. Confirm the bucket remains private and a public URL does not serve the object.

Check the Function invocation/log entry for this request. Expect one successful invocation and no logged payload, email address, filename, document content or secret.

## 6. Verify Resend

In Resend, locate the message whose provider ID exactly matches `email_provider_id` from the database. Verify:

- exactly one matching message exists;
- recipient is only `info@pure-coaching.com.au`;
- sender is `Pure Coaching Website <notifications@pure-coaching.com.au>`;
- the subject identifies a new NDIS enquiry;
- the synthetic form values are rendered correctly;
- the message says one private document was stored;
- there is no applicant confirmation email;
- there is no file attachment, public document URL or signed download link.

Do not send, resend or retry the notification from Resend.

## 7. Close the preview safely

1. Record the result without copying personal data or secret values.
2. Remove the synthetic Storage object through an authorised Dashboard workflow.
3. Delete the synthetic database row only after confirming the object was removed.
4. Remove `http://localhost:8765` from `ALLOWED_ORIGINS`, preserving the production origin.
5. Remove `localhost` from the Turnstile widget if it is not otherwise required.
6. Clear the browser preview configuration:

   ```js
   sessionStorage.removeItem('pure-form-submission-preview');
   ```

7. Stop the local HTTP server.

The Resend event may remain in provider audit history. It is synthetic and must not be resent.
