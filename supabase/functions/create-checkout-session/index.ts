import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const MAX_REQUEST_BYTES = 16 * 1024;
const STRIPE_TIMEOUT_MS = 10_000;
const STRIPE_API_VERSION = "2026-11-18.endive";
const TURNSTILE_ACTION = "private_checkout";
const SESSION_LIFETIME_SECONDS = 60 * 60;

type JsonRecord = Record<string, unknown>;
type EnvReader = (name: string) => string | undefined;
type Fetcher = typeof fetch;

type RpcResult = {
  data: unknown;
  error: { message?: string; code?: string } | null;
};

export type CheckoutRpcClient = {
  rpc: (name: string, args?: JsonRecord) => Promise<RpcResult>;
};

export type CheckoutHandlerDependencies = {
  env?: EnvReader;
  fetch?: Fetcher;
  now?: () => Date;
  createSupabaseClient?: (url: string, key: string) => CheckoutRpcClient;
};

export type ValidatedBooking = {
  clientRequestId: string;
  packageKey: keyof typeof PACKAGE_CATALOG;
  purchaser: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  };
  booking: {
    days: string[];
    time: string;
    notes: string;
  };
};

type PackageDefinition = {
  key: keyof typeof PACKAGE_CATALOG;
  name: string;
  sessions: number;
  amountCents: number;
  currency: "AUD";
  priceSecret: string;
  priceId: string;
};

type StripeEnvironment = "test" | "live";

type CheckoutClaim = {
  outcome?: string;
  reference?: string;
  checkoutUrl?: string;
  sessionExpiresAt?: string;
  claimCount?: number;
};

export const PACKAGE_CATALOG = {
  "5-sessions": {
    name: "5 Sessions",
    sessions: 5,
    amountCents: 25000,
    currency: "AUD" as const,
    priceSecret: "STRIPE_PRICE_5_SESSIONS",
  },
  "10-sessions": {
    name: "10 Sessions",
    sessions: 10,
    amountCents: 50000,
    currency: "AUD" as const,
    priceSecret: "STRIPE_PRICE_10_SESSIONS",
  },
  "15-sessions": {
    name: "15 Sessions",
    sessions: 15,
    amountCents: 75000,
    currency: "AUD" as const,
    priceSecret: "STRIPE_PRICE_15_SESSIONS",
  },
} as const;

const ALLOWED_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const ALLOWED_TIMES = [
  "Morning (6 AM – 12 PM)",
  "Afternoon (12 PM – 5 PM)",
  "Evening (5 PM – 9 PM)",
  "I'm flexible",
] as const;

class RequestError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requiredEnv(name: string, env: EnvReader): string {
  const value = env(name)?.trim();
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
}

export function parseSupabaseSecretKeys(raw: string): string {
  let keys: unknown;
  try {
    keys = JSON.parse(raw);
  } catch {
    throw new Error(
      "Missing or invalid server configuration: SUPABASE_SECRET_KEYS",
    );
  }
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    throw new Error(
      "Missing or invalid server configuration: SUPABASE_SECRET_KEYS",
    );
  }
  const key = (keys as JsonRecord).default;
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("Missing default Supabase secret key");
  }
  return key;
}

function configuredOrigins(env: EnvReader): Set<string> {
  const origins = requiredEnv("ALLOWED_ORIGINS", env).split(",").map((value) =>
    value.trim()
  ).filter(Boolean);
  if (!origins.length || origins.some((origin) => origin === "*")) {
    throw new Error("Invalid server configuration: ALLOWED_ORIGINS");
  }
  return new Set(origins);
}

function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, accept",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Origin",
  };
}

function jsonResponse(
  origin: string,
  status: number,
  body: JsonRecord,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function asObject(value: unknown, name = "payload"): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "INVALID_PAYLOAD", `The ${name} is invalid.`);
  }
  return value as JsonRecord;
}

function textField(
  source: JsonRecord,
  name: string,
  maxLength: number,
  required = false,
): string {
  const raw = source[name];
  if (raw !== undefined && typeof raw !== "string") {
    throw new RequestError(
      400,
      "INVALID_FIELD",
      `The ${name} field is invalid.`,
    );
  }
  const value = typeof raw === "string" ? raw.trim() : "";
  if (required && !value) {
    throw new RequestError(
      400,
      "MISSING_FIELD",
      `The ${name} field is required.`,
    );
  }
  if (value.length > maxLength) {
    throw new RequestError(
      400,
      "FIELD_TOO_LONG",
      `The ${name} field is too long.`,
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new RequestError(
      400,
      "INVALID_FIELD",
      `The ${name} field contains invalid characters.`,
    );
  }
  return value;
}

function notesField(source: JsonRecord): string {
  const raw = source.notes;
  if (raw !== undefined && typeof raw !== "string") {
    throw new RequestError(400, "INVALID_FIELD", "The notes field is invalid.");
  }
  const value = typeof raw === "string"
    ? raw.trim().replace(/\r\n?/g, "\n")
    : "";
  if (value.length > 2000) {
    throw new RequestError(
      400,
      "FIELD_TOO_LONG",
      "The notes field is too long.",
    );
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new RequestError(
      400,
      "INVALID_FIELD",
      "The notes field contains invalid characters.",
    );
  }
  return value;
}

function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validAustralianPhone(value: string): boolean {
  const normalised = value.replace(/[\s()-]/g, "");
  return /^(?:04\d{8}|0[2378]\d{8}|\+614\d{8}|\+61[2378]\d{8})$/.test(
    normalised,
  );
}

export function validateBookingPayload(input: unknown): ValidatedBooking {
  const source = asObject(input);
  const clientRequestId = textField(source, "clientRequestId", 36, true)
    .toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(clientRequestId)
  ) {
    throw new RequestError(
      400,
      "INVALID_REQUEST_ID",
      "The checkout request identifier is invalid.",
    );
  }

  const packageKey = textField(
    source,
    "packageKey",
    30,
    true,
  ) as keyof typeof PACKAGE_CATALOG;
  if (!Object.hasOwn(PACKAGE_CATALOG, packageKey)) {
    throw new RequestError(
      400,
      "INVALID_PACKAGE",
      "The selected package is invalid.",
    );
  }

  const purchaserSource = asObject(source.purchaser, "purchaser information");
  const firstName = textField(purchaserSource, "firstName", 100, true);
  const lastName = textField(purchaserSource, "lastName", 100, true);
  const email = textField(purchaserSource, "email", 254, true).toLowerCase();
  const phone = textField(purchaserSource, "phone", 30, true);
  if (!validEmail(email)) {
    throw new RequestError(
      400,
      "INVALID_EMAIL",
      "Enter a valid email address.",
    );
  }
  if (!validAustralianPhone(phone)) {
    throw new RequestError(
      400,
      "INVALID_PHONE",
      "Enter a valid Australian phone number.",
    );
  }

  const bookingSource = asObject(source.booking, "booking information");
  if (
    !Array.isArray(bookingSource.days) || !bookingSource.days.length ||
    bookingSource.days.length > ALLOWED_DAYS.length
  ) {
    throw new RequestError(
      400,
      "INVALID_DAYS",
      "Select at least one valid preferred day.",
    );
  }
  if (
    !bookingSource.days.every((day) =>
      typeof day === "string" &&
      (ALLOWED_DAYS as readonly string[]).includes(day)
    )
  ) {
    throw new RequestError(
      400,
      "INVALID_DAYS",
      "Select only valid preferred days.",
    );
  }
  if (new Set(bookingSource.days).size !== bookingSource.days.length) {
    throw new RequestError(
      400,
      "INVALID_DAYS",
      "Preferred days must not be duplicated.",
    );
  }
  const days = ALLOWED_DAYS.filter((day) =>
    (bookingSource.days as string[]).includes(day)
  );
  const time = textField(bookingSource, "time", 50, true);
  if (!(ALLOWED_TIMES as readonly string[]).includes(time)) {
    throw new RequestError(
      400,
      "INVALID_TIME",
      "Select a valid preferred time.",
    );
  }

  return {
    clientRequestId,
    packageKey,
    purchaser: { firstName, lastName, email, phone },
    booking: { days: [...days], time, notes: notesField(bookingSource) },
  };
}

export function resolvePackage(
  packageKey: keyof typeof PACKAGE_CATALOG,
  env: EnvReader,
): PackageDefinition {
  const definition = PACKAGE_CATALOG[packageKey];
  const priceId = requiredEnv(definition.priceSecret, env);
  if (!/^price_[A-Za-z0-9]+$/.test(priceId) || priceId.length > 255) {
    throw new Error(`Invalid server configuration: ${definition.priceSecret}`);
  }
  return { key: packageKey, ...definition, priceId };
}

function stripeEnvironment(env: EnvReader): StripeEnvironment {
  const value = requiredEnv("STRIPE_CHECKOUT_ENVIRONMENT", env);
  if (value !== "test" && value !== "live") {
    throw new Error(
      "Invalid server configuration: STRIPE_CHECKOUT_ENVIRONMENT",
    );
  }
  return value;
}

function stripeSecret(env: EnvReader, environment: StripeEnvironment): string {
  const key = requiredEnv("STRIPE_SECRET_KEY", env);
  const expectedPrefix = environment === "test" ? "sk_test_" : "sk_live_";
  if (
    !key.startsWith(expectedPrefix) || key.length < expectedPrefix.length + 8
  ) {
    throw new Error("Stripe key does not match STRIPE_CHECKOUT_ENVIRONMENT");
  }
  return key;
}

export function trustedRedirectUrl(
  raw: string,
  origins: Set<string>,
  environment: StripeEnvironment,
  requireSessionPlaceholder = false,
): string {
  if (requireSessionPlaceholder && !raw.includes("{CHECKOUT_SESSION_ID}")) {
    throw new Error("Checkout success URL must contain {CHECKOUT_SESSION_ID}");
  }
  let parsed: URL;
  try {
    parsed = new URL(
      raw.replace("{CHECKOUT_SESSION_ID}", "synthetic-session-id"),
    );
  } catch {
    throw new Error("Invalid checkout redirect URL");
  }
  const localTestUrl = environment === "test" && parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !localTestUrl) || parsed.username ||
    parsed.password || !origins.has(parsed.origin)
  ) {
    throw new Error("Checkout redirect URL is not trusted");
  }
  return raw;
}

export function validateStripePrice(
  raw: unknown,
  selectedPackage: PackageDefinition,
  environment: StripeEnvironment,
): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RequestError(
      503,
      "PAYMENT_CONFIGURATION_ERROR",
      "Payment is temporarily unavailable.",
    );
  }
  const price = raw as JsonRecord;
  const expectedLiveMode = environment === "live";
  if (
    price.object !== "price" ||
    price.id !== selectedPackage.priceId ||
    price.active !== true ||
    price.currency !== "aud" ||
    price.unit_amount !== selectedPackage.amountCents ||
    price.type !== "one_time" ||
    (price.recurring !== null && price.recurring !== undefined) ||
    price.livemode !== expectedLiveMode
  ) {
    throw new RequestError(
      503,
      "PAYMENT_CONFIGURATION_ERROR",
      "Payment is temporarily unavailable.",
    );
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function trustedClientIp(request: Request): string | null {
  const value = request.headers.get("cf-connecting-ip")?.trim().toLowerCase() ||
    "";
  if (!value || value.length > 45) return null;
  const ipv4 = value.split(".");
  if (
    ipv4.length === 4 &&
    ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  ) return value;
  if (
    value.includes(":") && /^[0-9a-f:]+$/.test(value) && !value.includes(":::")
  ) return value;
  return null;
}

async function verifyTurnstile(
  token: string,
  request: Request,
  origin: string,
  env: EnvReader,
  fetcher: Fetcher,
): Promise<void> {
  if (!token || token.length > 2048) {
    throw new RequestError(
      400,
      "SECURITY_CHECK_REQUIRED",
      "Please complete the security check.",
    );
  }
  const body = new URLSearchParams({
    secret: requiredEnv("TURNSTILE_SECRET_KEY", env),
    response: token,
  });
  const ip = trustedClientIp(request);
  if (ip) body.set("remoteip", ip);
  const response = await fetcher(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body },
  );
  const result = await response.json().catch(() => null) as {
    success?: boolean;
    hostname?: string;
    action?: string;
  } | null;
  const expectedHostname = new URL(origin).hostname;
  if (
    !response.ok || !result?.success || result.hostname !== expectedHostname ||
    result.action !== TURNSTILE_ACTION
  ) {
    throw new RequestError(
      400,
      "SECURITY_CHECK_FAILED",
      "The security check could not be verified.",
    );
  }
}

async function enforceRateLimits(
  supabase: CheckoutRpcClient,
  request: Request,
  email: string,
  env: EnvReader,
): Promise<void> {
  if (env("RATE_LIMIT_ENABLED") === "false") return;
  const salt = requiredEnv("RATE_LIMIT_SALT", env);
  const ip = trustedClientIp(request) || "gateway-ip-unavailable";
  const keys = [
    [await sha256(`${salt}:private-checkout:ip:${ip}`), 5, 900],
    [await sha256(`${salt}:private-checkout:email:${email}`), 3, 3600],
  ] as const;
  for (const [rateKey, limit, windowSeconds] of keys) {
    const result = await supabase.rpc("enforce_form_submission_rate_limit", {
      p_rate_key: rateKey,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (result.error) throw new Error("Rate limit service unavailable");
    if (result.data !== true) {
      throw new RequestError(
        429,
        "RATE_LIMITED",
        "Too many checkout attempts. Please wait before trying again.",
      );
    }
  }
}

async function fetchWithTimeout(
  fetcher: Fetcher,
  input: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STRIPE_TIMEOUT_MS);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function retrieveStripePrice(
  selectedPackage: PackageDefinition,
  secretKey: string,
  environment: StripeEnvironment,
  fetcher: Fetcher,
): Promise<void> {
  const response = await fetchWithTimeout(
    fetcher,
    `https://api.stripe.com/v1/prices/${
      encodeURIComponent(selectedPackage.priceId)
    }`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Stripe-Version": STRIPE_API_VERSION,
      },
    },
  );
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new RequestError(
      503,
      "PAYMENT_CONFIGURATION_ERROR",
      "Payment is temporarily unavailable.",
    );
  }
  validateStripePrice(result, selectedPackage, environment);
}

async function claimDraft(
  supabase: CheckoutRpcClient,
  booking: ValidatedBooking,
  selectedPackage: PackageDefinition,
  payloadHash: string,
): Promise<CheckoutClaim> {
  const result = await supabase.rpc("claim_private_support_checkout_draft", {
    p_client_request_id: booking.clientRequestId,
    p_payload_hash: payloadHash,
    p_booking_data: { purchaser: booking.purchaser, booking: booking.booking },
    p_package_key: selectedPackage.key,
    p_package_name: selectedPackage.name,
    p_session_count: selectedPackage.sessions,
    p_total_amount_cents: selectedPackage.amountCents,
    p_currency: selectedPackage.currency,
    p_stripe_price_id: selectedPackage.priceId,
  });
  if (
    result.error || !result.data || typeof result.data !== "object" ||
    Array.isArray(result.data)
  ) {
    throw new Error("Checkout draft claim failed");
  }
  return result.data as CheckoutClaim;
}

async function finalizeDraft(
  supabase: CheckoutRpcClient,
  reference: string,
  payloadHash: string,
  sessionId: string,
  checkoutUrl: string,
  expiresAt: string,
): Promise<void> {
  const result = await supabase.rpc("finalize_private_support_checkout_draft", {
    p_reference: reference,
    p_payload_hash: payloadHash,
    p_stripe_checkout_session_id: sessionId,
    p_stripe_checkout_url: checkoutUrl,
    p_stripe_session_expires_at: expiresAt,
  });
  if (result.error || result.data !== true) {
    throw new Error("Checkout draft finalization failed");
  }
}

async function failDraft(
  supabase: CheckoutRpcClient,
  reference: string,
  payloadHash: string,
  code: string,
): Promise<void> {
  const result = await supabase.rpc("fail_private_support_checkout_draft", {
    p_reference: reference,
    p_payload_hash: payloadHash,
    p_error_code: code,
  });
  if (result.error || result.data !== true) {
    console.error(
      "Checkout draft failure state requires administrative recovery",
    );
  }
}

function checkoutClaimResponse(
  origin: string,
  claim: CheckoutClaim,
): Response | null {
  if (claim.outcome === "existing") {
    if (
      typeof claim.checkoutUrl !== "string" ||
      typeof claim.sessionExpiresAt !== "string"
    ) {
      throw new Error("Stored Checkout Session is incomplete");
    }
    return jsonResponse(origin, 200, {
      ok: true,
      checkoutUrl: claim.checkoutUrl,
      expiresAt: claim.sessionExpiresAt,
      reused: true,
    });
  }
  if (claim.outcome === "in_progress") {
    throw new RequestError(
      409,
      "CHECKOUT_IN_PROGRESS",
      "This checkout is already being prepared. Please wait and try again.",
    );
  }
  if (claim.outcome === "conflict") {
    throw new RequestError(
      409,
      "DUPLICATE_REQUEST",
      "This checkout request identifier has already been used.",
    );
  }
  if (
    ["failed", "expired", "completed", "exhausted"].includes(
      String(claim.outcome),
    )
  ) {
    throw new RequestError(
      409,
      "START_NEW_CHECKOUT",
      "Please start a new checkout request.",
    );
  }
  if (claim.outcome !== "claimed" || typeof claim.reference !== "string") {
    throw new Error("Unexpected checkout draft state");
  }
  return null;
}

async function createStripeCheckoutSession(
  fetcher: Fetcher,
  secretKey: string,
  environment: StripeEnvironment,
  selectedPackage: PackageDefinition,
  booking: ValidatedBooking,
  reference: string,
  successUrl: string,
  cancelUrl: string,
  now: Date,
): Promise<{ id: string; url: string; expiresAt: string }> {
  const expiresAt = Math.floor(now.getTime() / 1000) + SESSION_LIFETIME_SECONDS;
  const body = new URLSearchParams({
    mode: "payment",
    "line_items[0][price]": selectedPackage.priceId,
    "line_items[0][quantity]": "1",
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: booking.purchaser.email,
    client_reference_id: reference,
    "metadata[checkout_reference]": reference,
    "payment_intent_data[metadata][checkout_reference]": reference,
    expires_at: String(expiresAt),
    locale: "en-GB",
    submit_type: "pay",
  });
  const response = await fetchWithTimeout(
    fetcher,
    "https://api.stripe.com/v1/checkout/sessions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `private-checkout/${reference}`,
        "Stripe-Version": STRIPE_API_VERSION,
      },
      body,
    },
  );
  const result = await response.json().catch(() => null) as JsonRecord | null;
  if (!response.ok) {
    throw new RequestError(
      502,
      "CHECKOUT_PROVIDER_ERROR",
      "The secure payment page could not be prepared.",
    );
  }
  const id = typeof result?.id === "string" ? result.id : "";
  const url = typeof result?.url === "string" ? result.url : "";
  const returnedExpiry = typeof result?.expires_at === "number"
    ? result.expires_at
    : 0;
  const expectedLiveMode = environment === "live";
  if (
    !/^cs_(test|live)_[A-Za-z0-9]+$/.test(id) ||
    !url.startsWith("https://") ||
    returnedExpiry <= Math.floor(now.getTime() / 1000) ||
    result?.livemode !== expectedLiveMode
  ) {
    throw new Error("Stripe returned an invalid Checkout Session");
  }
  return { id, url, expiresAt: new Date(returnedExpiry * 1000).toISOString() };
}

export function createCheckoutHandler(
  dependencies: CheckoutHandlerDependencies = {},
) {
  const env = dependencies.env || ((name: string) => Deno.env.get(name));
  const fetcher = dependencies.fetch || fetch;
  const now = dependencies.now || (() => new Date());
  const clientFactory = dependencies.createSupabaseClient ||
    ((url: string, key: string) =>
      createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      }) as unknown as CheckoutRpcClient);

  return async function handleCheckoutRequest(
    request: Request,
  ): Promise<Response> {
    const origin = request.headers.get("Origin") || "";
    let origins: Set<string>;
    try {
      origins = configuredOrigins(env);
    } catch {
      return new Response("Server configuration error", { status: 500 });
    }
    if (!origin || !origins.has(origin)) {
      return new Response("Origin not allowed", { status: 403 });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return jsonResponse(origin, 405, {
        ok: false,
        error: "Method not allowed.",
      });
    }
    if (env("PRIVATE_CHECKOUT_ENABLED") !== "true") {
      return jsonResponse(origin, 503, {
        ok: false,
        code: "CHECKOUT_UNAVAILABLE",
        error: "Online payment is not available yet.",
      });
    }

    const contentType =
      request.headers.get("content-type")?.split(";", 1)[0].trim()
        .toLowerCase() || "";
    if (contentType !== "application/json") {
      return jsonResponse(origin, 415, {
        ok: false,
        error: "The checkout format is not supported.",
      });
    }
    const contentLengthHeader = request.headers.get("content-length")?.trim() ||
      "";
    if (
      contentLengthHeader &&
      (!/^\d+$/.test(contentLengthHeader) ||
        Number(contentLengthHeader) > MAX_REQUEST_BYTES)
    ) {
      return jsonResponse(origin, 413, {
        ok: false,
        error: "The checkout request is too large.",
      });
    }

    try {
      const rawBody = await request.text();
      const bodyBytes = new TextEncoder().encode(rawBody).length;
      if (!bodyBytes || bodyBytes > MAX_REQUEST_BYTES) {
        throw new RequestError(
          413,
          "INVALID_REQUEST_SIZE",
          "The checkout request is too large.",
        );
      }
      let raw: unknown;
      try {
        raw = JSON.parse(rawBody);
      } catch {
        throw new RequestError(
          400,
          "INVALID_JSON",
          "The checkout request is invalid.",
        );
      }
      const source = asObject(raw);
      const booking = validateBookingPayload(source);
      const turnstileToken = textField(source, "turnstileToken", 2048, true);
      const environment = stripeEnvironment(env);
      const secretKey = stripeSecret(env, environment);
      const selectedPackage = resolvePackage(booking.packageKey, env);
      const successUrl = trustedRedirectUrl(
        requiredEnv("PRIVATE_CHECKOUT_SUCCESS_URL", env),
        origins,
        environment,
        true,
      );
      const cancelUrl = trustedRedirectUrl(
        requiredEnv("PRIVATE_CHECKOUT_CANCEL_URL", env),
        origins,
        environment,
      );
      const supabase = clientFactory(
        requiredEnv("SUPABASE_URL", env),
        parseSupabaseSecretKeys(requiredEnv("SUPABASE_SECRET_KEYS", env)),
      );

      await verifyTurnstile(turnstileToken, request, origin, env, fetcher);
      await enforceRateLimits(supabase, request, booking.purchaser.email, env);
      await retrieveStripePrice(
        selectedPackage,
        secretKey,
        environment,
        fetcher,
      );

      const canonicalPayload = JSON.stringify({
        clientRequestId: booking.clientRequestId,
        packageKey: booking.packageKey,
        purchaser: booking.purchaser,
        booking: booking.booking,
      });
      const payloadHash = await sha256(canonicalPayload);
      const claim = await claimDraft(
        supabase,
        booking,
        selectedPackage,
        payloadHash,
      );
      const existingResponse = checkoutClaimResponse(origin, claim);
      if (existingResponse) return existingResponse;
      const reference = claim.reference as string;

      let session: { id: string; url: string; expiresAt: string };
      try {
        session = await createStripeCheckoutSession(
          fetcher,
          secretKey,
          environment,
          selectedPackage,
          booking,
          reference,
          successUrl,
          cancelUrl,
          now(),
        );
      } catch (error) {
        if (
          error instanceof RequestError &&
          error.code === "CHECKOUT_PROVIDER_ERROR"
        ) {
          await failDraft(
            supabase,
            reference,
            payloadHash,
            "stripe_request_rejected",
          );
        }
        throw error;
      }

      await finalizeDraft(
        supabase,
        reference,
        payloadHash,
        session.id,
        session.url,
        session.expiresAt,
      );
      return jsonResponse(origin, 200, {
        ok: true,
        checkoutUrl: session.url,
        expiresAt: session.expiresAt,
        reused: false,
      });
    } catch (error) {
      if (error instanceof RequestError) {
        return jsonResponse(origin, error.status, {
          ok: false,
          code: error.code,
          error: error.message,
        });
      }
      console.error("Checkout session creation failed", {
        errorType: error instanceof Error ? error.name : "Unknown",
      });
      return jsonResponse(origin, 500, {
        ok: false,
        error:
          "The secure payment page could not be prepared. Please try again.",
      });
    }
  };
}

export const handleRequest = createCheckoutHandler();

export default { fetch: handleRequest };
