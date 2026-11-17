import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const FORM_TYPE = "intake";
const BUCKET = "referral-documents";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 35 * 1024 * 1024;
const MAX_REPORTS = 3;
const NOTIFICATION_TO = "info@pure-coaching.com.au";
const NOTIFICATION_FROM = "Pure Coaching Website <notifications@pure-coaching.com.au>";

const allowedValues = {
  contactFor: ["Myself", "Someone else"],
  support: ["private", "ndis", "child-safety", "unsure"],
  intent: ["enquiry", "enrolment", "referral", "general", "support-coordination"],
  ndisPlan: ["Yes", "No", "I'm not sure"],
  fundingManagement: ["Self-managed", "Plan-managed", "NDIA-managed (Agency-managed)", "A combination of these", "I'm not sure"],
  supportCoordinator: ["Yes", "No", "I'm not sure"],
  changeCoordinator: ["Yes", "No", "I'm not sure"],
  ageRange: ["Under 12", "12–17", "18–24", "25+", "Prefer not to say"],
  preferredContact: ["Phone", "Email", "Either"],
  contactTime: ["", "Morning", "Afternoon", "Either", "Other"]
} as const;

const allowedRoles = [
  "Participant / person seeking support",
  "Parent or family member",
  "Carer",
  "Support Coordinator",
  "Case Manager",
  "Child Safety professional",
  "Other professional",
  "Other"
];

const fileTypes = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
} as const;

type JsonRecord = Record<string, unknown>;
type StoredAttachment = {
  category: "ndisPlanDocument" | "supportingReports";
  bucket: string;
  path: string;
  contentType: string;
  size: number;
};

class RequestError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
}

function allowedOrigins(): Set<string> {
  return new Set(requiredEnv("ALLOWED_ORIGINS").split(",").map((origin) => origin.trim()).filter(Boolean));
}

function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, accept",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Origin"
  };
}

function jsonResponse(origin: string, status: number, body: JsonRecord): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" }
  });
}

function asObject(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "INVALID_PAYLOAD", "The submitted form data is invalid.");
  }
  return value as JsonRecord;
}

function textField(source: JsonRecord, name: string, maxLength: number, required = false): string {
  const raw = source[name];
  if (raw !== undefined && typeof raw !== "string") {
    throw new RequestError(400, "INVALID_FIELD", `The ${name} field is invalid.`);
  }
  const value = typeof raw === "string" ? raw.trim() : "";
  if (required && !value) throw new RequestError(400, "MISSING_FIELD", `The ${name} field is required.`);
  if (value.length > maxLength) throw new RequestError(400, "FIELD_TOO_LONG", `The ${name} field is too long.`);
  return value;
}

function enumField(source: JsonRecord, name: keyof typeof allowedValues, required = false): string {
  const value = textField(source, name, 100, required);
  const values = allowedValues[name] as readonly string[];
  if (value && !values.includes(value)) throw new RequestError(400, "INVALID_FIELD", `The ${name} field is invalid.`);
  return value;
}

function validateEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateAustralianPhone(value: string): boolean {
  const normalised = value.replace(/[\s()-]/g, "");
  return /^(?:04\d{8}|0[2378]\d{8}|\+614\d{8}|\+61[2378]\d{8})$/.test(normalised);
}

function validatePayload(input: unknown): JsonRecord {
  const source = asObject(input);
  const clientSubmissionId = textField(source, "clientSubmissionId", 80, true);
  if (!/^[a-zA-Z0-9-]{20,80}$/.test(clientSubmissionId)) {
    throw new RequestError(400, "INVALID_SUBMISSION_ID", "The submission identifier is invalid.");
  }

  const contactFor = enumField(source, "contactFor", true);
  const support = enumField(source, "support", true);
  const intent = enumField(source, "intent", true);
  const firstName = textField(source, "firstName", 100, true);
  const lastName = textField(source, "lastName", 100, true);
  const email = textField(source, "email", 254, true).toLowerCase();
  const phone = textField(source, "phone", 30, true);
  const role = textField(source, "role", 100, contactFor === "Someone else");
  const roleOther = textField(source, "roleOther", 150, role === "Other");
  const personFirstName = textField(source, "personFirstName", 100, contactFor === "Someone else");
  const personLastName = textField(source, "personLastName", 100, contactFor === "Someone else");
  const ageRange = enumField(source, "ageRange", true);
  const message = textField(source, "message", 5000, true);
  const preferredContact = enumField(source, "preferredContact", true);
  const contactTime = enumField(source, "contactTime");
  const contactTimeOther = textField(source, "contactTimeOther", 200, contactTime === "Other");
  const website = textField(source, "website", 200);

  if (website) throw new RequestError(400, "SPAM_REJECTED", "The submission could not be accepted.");
  if (!validateEmail(email)) throw new RequestError(400, "INVALID_EMAIL", "Please provide a valid email address.");
  if (!validateAustralianPhone(phone)) throw new RequestError(400, "INVALID_PHONE", "Please provide a valid Australian phone number.");
  if (role && !allowedRoles.includes(role)) throw new RequestError(400, "INVALID_FIELD", "The role field is invalid.");
  if (source.consent !== true) throw new RequestError(400, "CONSENT_REQUIRED", "Consent is required.");

  const coordination = support === "ndis" && intent === "support-coordination";
  const ndisPlan = support === "ndis" && !coordination ? enumField(source, "ndisPlan", true) : "";
  const needsPlanDetails = support === "ndis" && (coordination || ndisPlan === "Yes");
  const fundingManagement = needsPlanDetails ? enumField(source, "fundingManagement", true) : "";
  const supportCoordinator = coordination ? enumField(source, "supportCoordinator", true) : "";
  const changeCoordinator = coordination && supportCoordinator === "Yes" ? enumField(source, "changeCoordinator", true) : "";

  return {
    clientSubmissionId,
    intent,
    contactFor,
    role,
    roleOther,
    firstName,
    lastName,
    email,
    phone,
    support,
    ndisPlan,
    fundingManagement,
    supportCoordinator,
    changeCoordinator,
    personFirstName,
    personLastName,
    primaryDisability: ["ndis", "private"].includes(support) ? textField(source, "primaryDisability", 250) : "",
    secondaryDisabilities: ["ndis", "private"].includes(support) ? textField(source, "secondaryDisabilities", 1000) : "",
    ageRange,
    message,
    preferredContact,
    contactTime,
    contactTimeOther,
    consent: true
  };
}

function extensionFor(file: File): keyof typeof fileTypes {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  if (!(extension in fileTypes)) throw new RequestError(400, "INVALID_FILE_TYPE", "Documents must be PDF, DOC or DOCX files.");
  return extension as keyof typeof fileTypes;
}

async function hasExpectedSignature(file: File, extension: keyof typeof fileTypes): Promise<boolean> {
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (extension === "pdf") return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  if (extension === "doc") return [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, index) => bytes[index] === byte);
  return bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]);
}

async function validateFiles(formData: FormData, support: unknown): Promise<Array<{ category: StoredAttachment["category"]; file: File; extension: keyof typeof fileTypes }>> {
  const planEntries = formData.getAll("ndisPlanDocument");
  const reportEntries = formData.getAll("supportingReports");
  if (planEntries.length > 1 || reportEntries.length > MAX_REPORTS) {
    throw new RequestError(400, "TOO_MANY_FILES", "Too many documents were attached.");
  }
  if (support !== "ndis" && planEntries.length + reportEntries.length > 0) {
    throw new RequestError(400, "FILES_NOT_ALLOWED", "Documents are only accepted with NDIS enquiries.");
  }

  const entries = [
    ...planEntries.map((file) => ({ category: "ndisPlanDocument" as const, file })),
    ...reportEntries.map((file) => ({ category: "supportingReports" as const, file }))
  ];
  if (entries.some(({ file }) => !(file instanceof File))) {
    throw new RequestError(400, "INVALID_FILE", "An attached document is invalid.");
  }
  const files = entries as Array<{ category: StoredAttachment["category"]; file: File }>;
  if (files.reduce((total, { file }) => total + file.size, 0) > MAX_TOTAL_BYTES) {
    throw new RequestError(413, "FILES_TOO_LARGE", "The combined document size is too large.");
  }

  const validated = [];
  for (const entry of files) {
    if (entry.file.size < 4 || entry.file.size > MAX_FILE_BYTES) {
      throw new RequestError(400, "INVALID_FILE_SIZE", "Each document must be 10 MB or smaller.");
    }
    const extension = extensionFor(entry.file);
    const expectedType = fileTypes[extension];
    if (entry.file.type && entry.file.type !== "application/octet-stream" && entry.file.type !== expectedType) {
      throw new RequestError(400, "INVALID_FILE_TYPE", "A document's type does not match its filename.");
    }
    if (!(await hasExpectedSignature(entry.file, extension))) {
      throw new RequestError(400, "INVALID_FILE_CONTENT", "A document's contents do not match an allowed file type.");
    }
    validated.push({ ...entry, extension });
  }
  return validated;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyTurnstile(token: string, request: Request, origin: string): Promise<void> {
  if (!token || token.length > 2048) throw new RequestError(400, "SECURITY_CHECK_REQUIRED", "Please complete the security check.");
  const body = new URLSearchParams({ secret: requiredEnv("TURNSTILE_SECRET_KEY"), response: token });
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (ip) body.set("remoteip", ip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const result = await response.json().catch(() => null) as { success?: boolean; hostname?: string; action?: string } | null;
  const expectedHostname = new URL(origin).hostname;
  if (!response.ok || !result?.success || (result.hostname && result.hostname !== expectedHostname) || (result.action && result.action !== "intake")) {
    throw new RequestError(400, "SECURITY_CHECK_FAILED", "The security check could not be verified.");
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  }[character] as string));
}

function labelFor(key: string): string {
  const labels: Record<string, string> = {
    intent: "Enquiry type", contactFor: "Contacting for", role: "Role", roleOther: "Role details",
    firstName: "First name", lastName: "Last name", email: "Email", phone: "Phone", support: "Support pathway",
    ndisPlan: "NDIS plan", fundingManagement: "Funding management", supportCoordinator: "Current Support Coordinator",
    changeCoordinator: "Looking to change coordinator", personFirstName: "Participant first name", personLastName: "Participant last name",
    primaryDisability: "Primary disability", secondaryDisabilities: "Secondary disabilities", ageRange: "Age range",
    message: "How can we help?", preferredContact: "Preferred contact", contactTime: "Best contact time",
    contactTimeOther: "Contact time details"
  };
  return labels[key] || key;
}

function emailContent(data: JsonRecord, attachmentCount: number, submissionId: string | number): { subject: string; html: string; text: string } {
  const hidden = new Set(["clientSubmissionId", "consent"]);
  const rows = Object.entries(data).filter(([key, value]) => !hidden.has(key) && value !== "").map(([key, value]) => ({ label: labelFor(key), value: String(value) }));
  const rowsHtml = rows.map(({ label, value }) => `<tr><th style="padding:10px 12px;text-align:left;vertical-align:top;border-bottom:1px solid #e7edf1;color:#1D252D;width:34%;font-size:14px">${escapeHtml(label)}</th><td style="padding:10px 12px;border-bottom:1px solid #e7edf1;color:#020A0A;font-size:14px;white-space:pre-wrap">${escapeHtml(value)}</td></tr>`).join("");
  const documentNotice = attachmentCount > 0
    ? `<div style="margin:20px 0;padding:14px 16px;border-left:4px solid #FF5900;background:#fff5ef;color:#1D252D"><strong>${attachmentCount} private document${attachmentCount === 1 ? "" : "s"} stored.</strong><br>Documents are not attached to this email. Access them only through the approved private Supabase workflow.</div>`
    : "";
  const support = escapeHtml(data.support || "website");
  const subject = `New Pure Coaching ${String(data.support || "website")} enquiry`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f7f9;font-family:Arial,sans-serif;color:#020A0A"><div style="max-width:680px;margin:0 auto;padding:28px 16px"><div style="height:8px;background:#FF5900;border-radius:12px 12px 0 0"></div><div style="background:#fff;padding:28px;border-radius:0 0 12px 12px"><p style="margin:0 0 8px;color:#FF5900;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase">Pure Coaching website</p><h1 style="margin:0 0 8px;color:#1D252D;font-size:26px">New ${support} enquiry</h1><p style="margin:0 0 22px;color:#42515c">Submission reference: ${escapeHtml(submissionId)}</p>${documentNotice}<table role="presentation" style="width:100%;border-collapse:collapse;background:#f8fbfd;border:1px solid #B7DCF6;border-radius:8px">${rowsHtml}</table><p style="margin:22px 0 0;color:#5d6971;font-size:12px">This notification contains personal information. Handle it according to Pure Coaching's privacy and retention procedures.</p></div></div></body></html>`;
  const text = [`New Pure Coaching ${String(data.support || "website")} enquiry`, `Submission reference: ${submissionId}`, "", ...rows.map(({ label, value }) => `${label}: ${value}`), "", attachmentCount ? `${attachmentCount} private document(s) stored in Supabase. Documents are not attached to this email.` : ""].filter(Boolean).join("\n");
  return { subject, html, text };
}

async function sendNotification(data: JsonRecord, attachmentCount: number, submissionId: string | number): Promise<boolean> {
  const content = emailContent(data, attachmentCount, submissionId);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEnv("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `pure-form-${submissionId}`
    },
    body: JSON.stringify({
      from: NOTIFICATION_FROM,
      to: [NOTIFICATION_TO],
      reply_to: String(data.email),
      subject: content.subject,
      html: content.html,
      text: content.text
    })
  });
  return response.ok;
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin") || "";
  let origins: Set<string>;
  try {
    origins = allowedOrigins();
  } catch {
    return new Response("Server configuration error", { status: 500 });
  }
  if (!origin || !origins.has(origin)) return new Response("Origin not allowed", { status: 403 });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return jsonResponse(origin, 405, { ok: false, error: "Method not allowed." });

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_TOTAL_BYTES + 1024 * 1024) return jsonResponse(origin, 413, { ok: false, error: "The submission is too large." });

  let submissionId: string | number | null = null;
  let uploadedPaths: string[] = [];
  try {
    const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const formData = await request.formData();
    if (formData.get("formType") !== FORM_TYPE) throw new RequestError(400, "INVALID_FORM_TYPE", "This form type is not supported.");

    const payloadText = formData.get("payload");
    if (typeof payloadText !== "string" || payloadText.length > 20000) throw new RequestError(400, "INVALID_PAYLOAD", "The submitted form data is invalid.");
    let parsed: unknown;
    try { parsed = JSON.parse(payloadText); } catch { throw new RequestError(400, "INVALID_PAYLOAD", "The submitted form data is invalid."); }
    const data = validatePayload(parsed);
    const files = await validateFiles(formData, data.support);
    await verifyTurnstile(String(formData.get("turnstileToken") || ""), request, origin);

    const existing = await supabase.from("form_submissions").select("id,attachments,email_status").contains("form_data", { clientSubmissionId: data.clientSubmissionId }).maybeSingle();
    if (existing.data) {
      const storedCount = Array.isArray(existing.data.attachments) ? existing.data.attachments.length : 0;
      if (storedCount >= files.length) return jsonResponse(origin, 200, { ok: true, duplicate: true, submissionId: existing.data.id });
      throw new RequestError(409, "SUBMISSION_IN_PROGRESS", "This submission is already being processed.");
    }

    const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const salt = requiredEnv("RATE_LIMIT_SALT");
    const ipKey = await sha256(`${salt}:ip:${ip}`);
    const emailKey = await sha256(`${salt}:email:${data.email}`);
    for (const [rateKey, limit, windowSeconds] of [[ipKey, 5, 900], [emailKey, 3, 3600]] as const) {
      const result = await supabase.rpc("check_form_submission_rate_limit", { p_rate_key: rateKey, p_limit: limit, p_window_seconds: windowSeconds });
      if (result.error) throw new Error("Rate limit service unavailable");
      if (result.data !== true) throw new RequestError(429, "RATE_LIMITED", "Too many submissions. Please wait before trying again.");
    }

    const inserted = await supabase.from("form_submissions").insert({ form_type: FORM_TYPE, form_data: data, attachments: [], email_status: "pending", email_sent_at: null }).select("id").single();
    if (inserted.error) {
      if (inserted.error.code === "23505") {
        const duplicate = await supabase.from("form_submissions").select("id").contains("form_data", { clientSubmissionId: data.clientSubmissionId }).maybeSingle();
        if (duplicate.data) return jsonResponse(origin, 200, { ok: true, duplicate: true, submissionId: duplicate.data.id });
      }
      throw new Error("Submission storage failed");
    }
    submissionId = inserted.data.id;

    const attachments: StoredAttachment[] = [];
    for (const entry of files) {
      const path = `${submissionId}/${entry.category}/${crypto.randomUUID()}.${entry.extension}`;
      const upload = await supabase.storage.from(BUCKET).upload(path, entry.file, { contentType: fileTypes[entry.extension], upsert: false, cacheControl: "0" });
      if (upload.error) throw new Error("Private document storage failed");
      uploadedPaths.push(path);
      attachments.push({ category: entry.category, bucket: BUCKET, path, contentType: fileTypes[entry.extension], size: entry.file.size });
    }

    const attachmentUpdate = await supabase.from("form_submissions").update({ attachments }).eq("id", submissionId);
    if (attachmentUpdate.error) throw new Error("Attachment reference storage failed");

    let sent = false;
    try { sent = await sendNotification(data, attachments.length, submissionId); } catch { sent = false; }
    const emailUpdate = await supabase.from("form_submissions").update({ email_status: sent ? "sent" : "failed", email_sent_at: sent ? new Date().toISOString() : null }).eq("id", submissionId);
    if (emailUpdate.error) console.error("Email status update failed", { submissionId });
    if (!sent) console.error("Notification delivery failed", { submissionId });

    return jsonResponse(origin, 200, { ok: true, submissionId });
  } catch (error) {
    if (submissionId !== null) {
      try {
        const cleanup = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
        if (uploadedPaths.length) await cleanup.storage.from(BUCKET).remove(uploadedPaths);
        await cleanup.from("form_submissions").delete().eq("id", submissionId);
      } catch { console.error("Submission cleanup failed", { submissionId }); }
    }
    if (error instanceof RequestError) return jsonResponse(origin, error.status, { ok: false, code: error.code, error: error.message });
    console.error("Form submission failed", { submissionId, errorType: error instanceof Error ? error.name : "Unknown" });
    return jsonResponse(origin, 500, { ok: false, error: "We could not securely store your enquiry. Please try again." });
  }
});
