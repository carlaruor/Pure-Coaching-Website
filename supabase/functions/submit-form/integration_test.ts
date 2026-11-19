// Run only against an explicitly approved local/staging Function configured
// with Cloudflare Turnstile test credentials and synthetic data.

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const endpoint = Deno.env.get("TEST_SUBMIT_FORM_URL") || "";
const origin = Deno.env.get("TEST_ALLOWED_ORIGIN") || "";
const turnstileToken = Deno.env.get("TEST_TURNSTILE_TOKEN") || "";
const integrationReady = Boolean(endpoint && origin && turnstileToken);

function payload(clientSubmissionId: string): Record<string, unknown> {
  return {
    clientSubmissionId,
    contactFor: "Myself",
    relationshipToParticipant: "Self",
    support: "private",
    intent: "enquiry",
    firstName: "Synthetic",
    lastName: "Concurrency Test",
    email: `synthetic-${clientSubmissionId}@example.invalid`,
    phone: "0400000000",
    participantFirstName: "Synthetic",
    participantLastName: "Concurrency Test",
    ageRange: "25+",
    message: "Synthetic integration test only. No participant data.",
    preferredContact: "Email",
    contactTime: "",
    consent: true,
    website: ""
  };
}

async function submit(clientSubmissionId: string, token = turnstileToken): Promise<Response> {
  const body = new FormData();
  body.set("formType", "intake");
  body.set("payload", JSON.stringify(payload(clientSubmissionId)));
  body.set("turnstileToken", token);
  return await fetch(endpoint, { method: "POST", headers: { Origin: origin }, body });
}

Deno.test({
  name: "rejects a synthetic request without a security token",
  ignore: !integrationReady,
  fn: async () => {
    const response = await submit(`synthetic-reject-${crypto.randomUUID()}`, "");
    assert(response.status === 400, `Expected 400, received ${response.status}`);
  }
});

Deno.test({
  name: "atomically accepts one of two concurrent synthetic submissions",
  ignore: !integrationReady,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const id = `synthetic-concurrency-${crypto.randomUUID()}`;
    const responses = await Promise.all([submit(id), submit(id)]);
    const statuses = responses.map((response) => response.status).sort();
    assert(statuses[0] === 200 && statuses[1] === 409, `Expected [200,409], received ${JSON.stringify(statuses)}`);
    const success = responses.find((response) => response.status === 200);
    const conflict = responses.find((response) => response.status === 409);
    assert(success && conflict, "Expected both a success and a conflict response");
    const successBody = await success.json() as Record<string, unknown>;
    assert(successBody.ok === true, "Winning submission did not succeed");
    const conflictBody = await conflict.json() as Record<string, unknown>;
    assert(conflictBody?.ok === false && conflictBody?.code === "DUPLICATE_SUBMISSION", "Duplicate did not return a safe conflict");
    assert(!("submissionId" in conflictBody), "Duplicate response exposed a stored submission identifier");
  }
});
