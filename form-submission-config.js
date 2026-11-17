'use strict';

// Public runtime configuration only. Never place Supabase or Resend secrets here.
// Keep `enabled` false until the Edge Function and security controls have been reviewed.
window.PURE_FORM_SUBMISSION_CONFIG = Object.freeze({
  enabled: false,
  endpoint: '',
  turnstileSiteKey: ''
});
