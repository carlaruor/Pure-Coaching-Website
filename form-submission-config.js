'use strict';

// Public runtime configuration only. Never place Supabase or Resend secrets here.
// Production values remain disabled until every launch gate in the deployment
// guide has passed. The configured Turnstile site key is public and must
// continue to match the reviewed Cloudflare widget rather than a test key.
const productionFormSubmissionConfig = {
  enabled: false,
  endpoint: 'https://ovsedudlfslldvhmswjy.supabase.co/functions/v1/submit-form',
  documentUploadsEnabled: false,
  turnstileSiteKey: '0x4AAAAAAGEZ9eLe8xa-7a_i'
};

function localPreviewFormSubmissionConfig() {
  try {
    const localHost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
    const previewRequested = new URLSearchParams(window.location.search).get('form-preview') === '1';
    if (!localHost || !previewRequested) return null;

    const stored = JSON.parse(sessionStorage.getItem('pure-form-submission-preview') || 'null');
    const endpoint = new URL(stored?.endpoint || '');
    const turnstileSiteKey = typeof stored?.turnstileSiteKey === 'string' ? stored.turnstileSiteKey.trim() : '';
    const approvedEndpoint = endpoint.protocol === 'https:'
      && /^[a-z0-9-]+\.supabase\.co$/i.test(endpoint.hostname)
      && endpoint.pathname === '/functions/v1/submit-form'
      && !endpoint.search
      && !endpoint.hash;
    if (!approvedEndpoint || turnstileSiteKey.length < 10 || turnstileSiteKey.length > 200) return null;

    return {
      enabled: true,
      endpoint: endpoint.href,
      turnstileSiteKey,
      documentUploadsEnabled: stored?.documentUploadsEnabled === true,
      preview: true
    };
  } catch {
    return null;
  }
}

window.PURE_FORM_SUBMISSION_CONFIG = Object.freeze(
  localPreviewFormSubmissionConfig() || productionFormSubmissionConfig
);
