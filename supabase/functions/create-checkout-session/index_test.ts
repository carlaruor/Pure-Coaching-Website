import {
  type CheckoutRpcClient,
  createCheckoutHandler,
  PACKAGE_CATALOG,
  resolvePackage,
  trustedRedirectUrl,
  validateBookingPayload,
  validateStripePrice,
} from "./index.ts";

function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertThrows(action: () => unknown, expected: string): void {
  try {
    action();
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes(expected),
      `Expected error containing ${expected}`,
    );
    return;
  }
  throw new Error(`Expected error containing ${expected}`);
}

const CLIENT_REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const CHECKOUT_REFERENCE = "523e4567-e89b-42d3-a456-426614174111";

function validPayload(): Record<string, unknown> {
  return {
    clientRequestId: CLIENT_REQUEST_ID,
    packageKey: "5-sessions",
    purchaser: {
      firstName: "Synthetic",
      lastName: "Customer",
      email: "synthetic@example.invalid",
      phone: "0400 000 000",
    },
    booking: {
      package: "Untrusted browser label",
      price: "$1.00 AUD",
      days: ["Wed", "Mon"],
      time: "I'm flexible",
      notes: "Synthetic availability only",
    },
    turnstileToken: "synthetic-turnstile-token",
  };
}

function environment(
  overrides: Record<string, string> = {},
): (name: string) => string | undefined {
  const values: Record<string, string> = {
    ALLOWED_ORIGINS: "https://example.test",
    PRIVATE_CHECKOUT_ENABLED: "true",
    PRIVATE_CHECKOUT_SUCCESS_URL:
      "https://example.test/payment-success.html?session_id={CHECKOUT_SESSION_ID}",
    PRIVATE_CHECKOUT_CANCEL_URL:
      "https://example.test/private-support.html?payment=cancelled",
    STRIPE_CHECKOUT_ENVIRONMENT: "test",
    STRIPE_SECRET_KEY: "sk_test_synthetic_secret",
    STRIPE_PRICE_5_SESSIONS: "price_synthetic5",
    STRIPE_PRICE_10_SESSIONS: "price_synthetic10",
    STRIPE_PRICE_15_SESSIONS: "price_synthetic15",
    TURNSTILE_SECRET_KEY: "turnstile-synthetic-secret",
    RATE_LIMIT_SALT: "synthetic-rate-limit-salt-at-least-32-characters",
    RATE_LIMIT_ENABLED: "true",
    SUPABASE_URL: "https://synthetic.supabase.co",
    SUPABASE_SECRET_KEYS: '{"default":"sb_secret_synthetic"}',
    ...overrides,
  };
  return (name) => values[name];
}

function jsonRequest(
  payload: Record<string, unknown>,
  origin = "https://example.test",
): Request {
  const body = JSON.stringify(payload);
  return new Request(
    "https://synthetic.supabase.co/functions/v1/create-checkout-session",
    {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "Content-Length": String(new TextEncoder().encode(body).length),
        "cf-connecting-ip": "203.0.113.8",
      },
      body,
    },
  );
}

function stripePrice(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "price_synthetic5",
    object: "price",
    active: true,
    currency: "aud",
    unit_amount: 25000,
    type: "one_time",
    recurring: null,
    livemode: false,
    ...overrides,
  };
}

function successfulRpc(
  calls: Array<{ name: string; args?: Record<string, unknown> }>,
  claimOutcome: Record<string, unknown> = {
    outcome: "claimed",
    reference: CHECKOUT_REFERENCE,
    claimCount: 1,
  },
): CheckoutRpcClient {
  return {
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === "enforce_form_submission_rate_limit") {
        return { data: true, error: null };
      }
      if (name === "claim_private_support_checkout_draft") {
        return { data: claimOutcome, error: null };
      }
      if (name === "finalize_private_support_checkout_draft") {
        return { data: true, error: null };
      }
      if (name === "fail_private_support_checkout_draft") {
        return { data: true, error: null };
      }
      return { data: null, error: { message: "Unexpected RPC" } };
    },
  };
}

Deno.test("validates and sanitises the existing booking fields without trusting browser pricing", () => {
  const booking = validateBookingPayload(validPayload());
  assert(booking.packageKey === "5-sessions");
  assert(booking.purchaser.email === "synthetic@example.invalid");
  assert(booking.booking.days.join(",") === "Mon,Wed");
  assert(!("price" in booking.booking));
  assert(!("package" in booking.booking));

  assertThrows(
    () =>
      validateBookingPayload({
        ...validPayload(),
        packageKey: "custom-package",
      }),
    "selected package",
  );
  assertThrows(() =>
    validateBookingPayload({
      ...validPayload(),
      booking: { days: ["Mon", "Mon"], time: "I'm flexible", notes: "" },
    }), "must not be duplicated");
  assertThrows(() =>
    validateBookingPayload({
      ...validPayload(),
      purchaser: {
        firstName: "Synthetic",
        lastName: "Customer",
        email: "bad",
        phone: "0400000000",
      },
    }), "valid email");
});

Deno.test("rejects malformed JSON as a client error", async () => {
  const handler = createCheckoutHandler({ env: environment() });
  const response = await handler(
    new Request(
      "https://synthetic.supabase.co/functions/v1/create-checkout-session",
      {
        method: "POST",
        headers: {
          Origin: "https://example.test",
          "Content-Type": "application/json",
        },
        body: "{invalid-json",
      },
    ),
  );
  const result = await response.json();
  assert(response.status === 400 && result.code === "INVALID_JSON");
});

Deno.test("resolves only server-configured package price IDs", () => {
  const selected = resolvePackage("10-sessions", environment());
  assert(selected.priceId === "price_synthetic10");
  assert(selected.sessions === 10);
  assert(selected.amountCents === 50000);
  assert(selected.currency === "AUD");
  assert(PACKAGE_CATALOG["15-sessions"].amountCents === 75000);
});

Deno.test("requires trusted server redirect URLs and a success placeholder", () => {
  const origins = new Set(["https://example.test"]);
  assert(
    trustedRedirectUrl(
      "https://example.test/payment-success.html?session_id={CHECKOUT_SESSION_ID}",
      origins,
      "test",
      true,
    ).includes("CHECKOUT_SESSION_ID"),
  );
  assertThrows(
    () =>
      trustedRedirectUrl(
        "https://evil.test/success?session_id={CHECKOUT_SESSION_ID}",
        origins,
        "test",
        true,
      ),
    "not trusted",
  );
  assertThrows(
    () =>
      trustedRedirectUrl("https://example.test/success", origins, "test", true),
    "must contain",
  );
});

Deno.test("verifies Stripe prices against the server catalogue and environment", () => {
  const selected = resolvePackage("5-sessions", environment());
  validateStripePrice(stripePrice(), selected, "test");
  assertThrows(
    () =>
      validateStripePrice(stripePrice({ unit_amount: 1 }), selected, "test"),
    "temporarily unavailable",
  );
  assertThrows(
    () =>
      validateStripePrice(stripePrice({ currency: "usd" }), selected, "test"),
    "temporarily unavailable",
  );
  assertThrows(
    () =>
      validateStripePrice(stripePrice({ livemode: true }), selected, "test"),
    "temporarily unavailable",
  );
  assertThrows(
    () =>
      validateStripePrice(
        stripePrice({ type: "recurring", recurring: { interval: "month" } }),
        selected,
        "test",
      ),
    "temporarily unavailable",
  );
});

Deno.test("creates one Stripe Checkout Session using an opaque reference and server price", async () => {
  const rpcCalls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const stripeRequests: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch =
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("turnstile")) {
        return new Response(
          JSON.stringify({
            success: true,
            hostname: "example.test",
            action: "private_checkout",
          }),
          { status: 200 },
        );
      }
      stripeRequests.push({ url, init });
      if (url.includes("/v1/prices/")) {
        return new Response(JSON.stringify(stripePrice()), { status: 200 });
      }
      if (url.endsWith("/v1/checkout/sessions")) {
        return new Response(
          JSON.stringify({
            id: "cs_test_synthetic123",
            url: "https://checkout.stripe.com/c/pay/cs_test_synthetic123",
            expires_at: 1795640400,
            livemode: false,
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  const handler = createCheckoutHandler({
    env: environment(),
    fetch: fakeFetch,
    now: () => new Date("2026-11-25T03:00:00.000Z"),
    createSupabaseClient: () => successfulRpc(rpcCalls),
  });

  const response = await handler(jsonRequest(validPayload()));
  const result = await response.json();
  assert(response.status === 200, JSON.stringify(result));
  assert(result.ok === true && result.reused === false);
  assert(
    stripeRequests.length === 2,
    `Expected price retrieval and Session creation, received ${stripeRequests.length}`,
  );
  const creation = stripeRequests.find((request) =>
    request.url.endsWith("/v1/checkout/sessions")
  );
  assert(creation);
  const body = new URLSearchParams(String(creation.init?.body));
  assert(body.get("line_items[0][price]") === "price_synthetic5");
  assert(body.get("line_items[0][quantity]") === "1");
  assert(body.get("client_reference_id") === CHECKOUT_REFERENCE);
  assert(body.get("metadata[checkout_reference]") === CHECKOUT_REFERENCE);
  assert(
    body.get("payment_intent_data[metadata][checkout_reference]") ===
      CHECKOUT_REFERENCE,
  );
  assert(body.get("customer_email") === "synthetic@example.invalid");
  assert(!String(creation.init?.body).includes("Synthetic%20Customer"));
  assert(!String(creation.init?.body).includes("25000"));
  assert(
    new Headers(creation.init?.headers).get("Idempotency-Key") ===
      `private-checkout/${CHECKOUT_REFERENCE}`,
  );
  assert(
    rpcCalls.filter((call) =>
      call.name === "claim_private_support_checkout_draft"
    ).length === 1,
  );
  assert(
    rpcCalls.filter((call) =>
      call.name === "finalize_private_support_checkout_draft"
    ).length === 1,
  );
  assert(
    rpcCalls.every((call) => !call.name.includes("private_support_purchases")),
  );
});

Deno.test("returns an existing checkout without creating a duplicate Stripe Session", async () => {
  const rpcCalls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  let checkoutCreationCount = 0;
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("turnstile")) {
      return new Response(
        JSON.stringify({
          success: true,
          hostname: "example.test",
          action: "private_checkout",
        }),
        { status: 200 },
      );
    }
    if (url.includes("/v1/prices/")) {
      return new Response(JSON.stringify(stripePrice()), { status: 200 });
    }
    if (url.endsWith("/v1/checkout/sessions")) checkoutCreationCount += 1;
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const handler = createCheckoutHandler({
    env: environment(),
    fetch: fakeFetch,
    createSupabaseClient: () =>
      successfulRpc(rpcCalls, {
        outcome: "existing",
        reference: CHECKOUT_REFERENCE,
        checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_existing",
        sessionExpiresAt: "2026-11-25T04:00:00.000Z",
      }),
  });
  const response = await handler(jsonRequest(validPayload()));
  const result = await response.json();
  assert(response.status === 200 && result.reused === true);
  assert(checkoutCreationCount === 0);
  assert(
    rpcCalls.every((call) =>
      call.name !== "finalize_private_support_checkout_draft"
    ),
  );
});

Deno.test("keeps checkout disabled by default and rejects invalid origins and Turnstile", async () => {
  const disabled = createCheckoutHandler({
    env: environment({ PRIVATE_CHECKOUT_ENABLED: "false" }),
  });
  const disabledResponse = await disabled(jsonRequest(validPayload()));
  assert(disabledResponse.status === 503);

  const wrongOrigin = createCheckoutHandler({ env: environment() });
  const wrongOriginResponse = await wrongOrigin(
    jsonRequest(validPayload(), "https://evil.test"),
  );
  assert(wrongOriginResponse.status === 403);

  const rpcCalls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const failedTurnstileFetch = (async (input: string | URL | Request) => {
    if (String(input).includes("turnstile")) {
      return new Response(JSON.stringify({ success: false }), { status: 200 });
    }
    throw new Error("Stripe must not be called after failed Turnstile");
  }) as typeof fetch;
  const failedTurnstile = createCheckoutHandler({
    env: environment(),
    fetch: failedTurnstileFetch,
    createSupabaseClient: () => successfulRpc(rpcCalls),
  });
  const failedTurnstileResponse = await failedTurnstile(
    jsonRequest(validPayload()),
  );
  assert(failedTurnstileResponse.status === 400);
  assert(rpcCalls.length === 0);

  const incompleteTurnstile = createCheckoutHandler({
    env: environment(),
    fetch: (async (input: string | URL | Request) => {
      if (String(input).includes("turnstile")) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      throw new Error(
        "Stripe must not be called for an incomplete Turnstile result",
      );
    }) as typeof fetch,
    createSupabaseClient: () => successfulRpc([]),
  });
  const incompleteTurnstileResponse = await incompleteTurnstile(
    jsonRequest(validPayload()),
  );
  assert(incompleteTurnstileResponse.status === 400);
});

Deno.test("rejects a concurrent duplicate before contacting Stripe", async () => {
  const rpcCalls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  let checkoutCreationCount = 0;
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("turnstile")) {
      return new Response(
        JSON.stringify({
          success: true,
          hostname: "example.test",
          action: "private_checkout",
        }),
        { status: 200 },
      );
    }
    if (url.includes("/v1/prices/")) {
      return new Response(JSON.stringify(stripePrice()), { status: 200 });
    }
    if (url.endsWith("/v1/checkout/sessions")) checkoutCreationCount += 1;
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const handler = createCheckoutHandler({
    env: environment(),
    fetch: fakeFetch,
    createSupabaseClient: () =>
      successfulRpc(rpcCalls, { outcome: "in_progress" }),
  });
  const response = await handler(jsonRequest(validPayload()));
  const result = await response.json();
  assert(response.status === 409 && result.code === "CHECKOUT_IN_PROGRESS");
  assert(checkoutCreationCount === 0);
});
