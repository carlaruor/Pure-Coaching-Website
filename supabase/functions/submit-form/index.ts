import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const FORM_TYPE = "intake";
const BUCKET = "referral-documents";
const EMPLOYMENT_FORM_TYPE = "employment_interest";
const EMPLOYMENT_BUCKET = "employment-resumes";
const MAX_RESUME_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 35 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_TOTAL_BYTES + 1024 * 1024;
const MAX_REPORTS = 3;
const MAX_DOCX_ENTRIES = 2048;
const MAX_DOCX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_DOCX_COMPRESSION_RATIO = 150;
const RESEND_TIMEOUT_MS = 10_000;
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
export type StoredAttachment = {
  category: "ndisPlanDocument" | "supportingReports";
  bucket: string;
  path: string;
  contentType: string;
  size: number;
  state: "pending" | "stored";
};

type SupabaseClient = ReturnType<typeof createClient>;
type NotificationResult = { sent: boolean; providerId: string | null; retryable: boolean };

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

export function parseSupabaseSecretKeys(raw: string): string {
  let keys: unknown;
  try {
    keys = JSON.parse(raw);
  } catch {
    throw new Error("Missing or invalid server configuration: SUPABASE_SECRET_KEYS");
  }
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    throw new Error("Missing or invalid server configuration: SUPABASE_SECRET_KEYS");
  }
  const key = (keys as Record<string, unknown>).default;
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("Missing default Supabase secret key");
  }
  return key;
}

function supabaseAdminKey(): string {
  return parseSupabaseSecretKeys(requiredEnv("SUPABASE_SECRET_KEYS"));
}

function allowedOrigins(): Set<string> {
  return new Set(requiredEnv("ALLOWED_ORIGINS").split(",").map((origin) => origin.trim()).filter(Boolean));
}

export function documentUploadsEnabled(value: string | undefined = Deno.env.get("DOCUMENT_UPLOADS_ENABLED")): boolean {
  return value === "true";
}

export function employmentResumeUploadsEnabled(value: string | undefined = Deno.env.get("EMPLOYMENT_RESUME_UPLOADS_ENABLED")): boolean {
  return value === "true";
}

export function enforceDocumentUploadSetting(formData: FormData, enabled: boolean): void {
  if (enabled) return;
  const containsFile = Array.from(formData.values()).some((value) => value instanceof File);
  if (containsFile) {
    throw new RequestError(
      400,
      "DOCUMENT_UPLOADS_DISABLED",
      "Document uploads are not currently available. Please submit your enquiry without attachments."
    );
  }
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

export function validatePayload(input: unknown): JsonRecord {
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

export function validateEmploymentPayload(input: unknown): JsonRecord {
  const source = asObject(input);
  const clientSubmissionId = textField(source, "clientSubmissionId", 80, true);
  if (!/^[a-zA-Z0-9-]{20,80}$/.test(clientSubmissionId)) {
    throw new RequestError(400, "INVALID_SUBMISSION_ID", "The submission identifier is invalid.");
  }
  const firstName = textField(source, "firstName", 100, true);
  const lastName = textField(source, "lastName", 100, true);
  const email = textField(source, "email", 254, true).toLowerCase();
  const phone = textField(source, "phone", 30, true);
  const previousExperience = textField(source, "previousExperience", 3, true);
  const experience = textField(source, "experience", 5000);
  const interestReason = textField(source, "interestReason", 5000);
  const website = textField(source, "website", 200);
  if (website) throw new RequestError(400, "SPAM_REJECTED", "The submission could not be accepted.");
  if (!validateEmail(email)) throw new RequestError(400, "INVALID_EMAIL", "Please provide a valid email address.");
  if (!validateAustralianPhone(phone)) throw new RequestError(400, "INVALID_PHONE", "Please provide a valid Australian phone number.");
  if (!["Yes", "No"].includes(previousExperience)) throw new RequestError(400, "INVALID_FIELD", "The previousExperience field is invalid.");
  if (source.consent !== true) throw new RequestError(400, "CONSENT_REQUIRED", "Consent is required.");
  return { clientSubmissionId, firstName, lastName, email, phone, previousExperience, experience, interestReason, consent: true };
}

function extensionFor(file: File): keyof typeof fileTypes {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  if (!(extension in fileTypes)) throw new RequestError(400, "INVALID_FILE_TYPE", "Documents must be PDF, DOC or DOCX files.");
  return extension as keyof typeof fileTypes;
}

function safeFilenameComponent(value: unknown, fallback: string): string {
  const component = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return component || fallback;
}

function brisbaneDateTime(date: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value || "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}${part("minute")}` };
}

function numericUniqueId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return (value % 1_000_000_000_000n).toString().padStart(12, "0");
}

export function employmentResumeObjectPath(
  data: JsonRecord,
  date = new Date(),
  uniqueId = numericUniqueId()
): string {
  const firstName = safeFilenameComponent(data.firstName, "Applicant");
  const lastName = safeFilenameComponent(data.lastName, "Unknown");
  const timestamp = brisbaneDateTime(date);
  const identifier = String(uniqueId).replace(/\D/g, "").slice(0, 18);
  if (identifier.length < 6) throw new RequestError(500, "STORAGE_PATH_ERROR", "The résumé storage path could not be generated.");
  return `${firstName}_${lastName}_${timestamp.date}_${timestamp.time}_${identifier}/resume.pdf`;
}

function participantName(data: JsonRecord): { firstName: string; lastName: string } {
  if (data.contactFor === "Myself") {
    const firstName = String(data.firstName || "").trim();
    const lastName = String(data.lastName || "").trim();
    if (!firstName || !lastName) throw new RequestError(400, "MISSING_FIELD", "The participant's first and last name are required.");
    return { firstName, lastName };
  }
  if (data.contactFor === "Someone else") {
    const firstName = String(data.personFirstName || "").trim();
    const lastName = String(data.personLastName || "").trim();
    if (!firstName || !lastName) throw new RequestError(400, "MISSING_FIELD", "The participant's first and last name are required.");
    return { firstName, lastName };
  }
  throw new RequestError(400, "INVALID_FIELD", "The contactFor field is invalid.");
}

export function storedDocumentFilename(
  data: JsonRecord,
  category: StoredAttachment["category"],
  extension: keyof typeof fileTypes,
  date = new Date(),
  uniqueId: string = crypto.randomUUID().replaceAll("-", "")
): string {
  const participant = participantName(data);
  const firstName = safeFilenameComponent(participant.firstName, "Participant");
  const lastName = safeFilenameComponent(participant.lastName, "Unknown");
  const documentType = category === "ndisPlanDocument" ? "NDIS_Plan" : "Supporting_Document";
  const timestamp = brisbaneDateTime(date);
  const identifier = safeFilenameComponent(uniqueId, crypto.randomUUID().replaceAll("-", ""));
  return `${firstName}_${lastName}_${timestamp.date}_${timestamp.time}_${documentType}_${identifier}.${extension}`;
}

function uint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function safeZipPath(name: string): boolean {
  return name.length > 0 && name.length <= 512 && !name.includes("\0") && !name.includes("\\") && !name.startsWith("/") && !name.split("/").includes("..");
}

export async function validateDocxArchive(file: File): Promise<boolean> {
  const tailSize = Math.min(file.size, 65_557);
  if (tailSize < 22) return false;
  const tail = new Uint8Array(await file.slice(file.size - tailSize).arrayBuffer());
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let endOffset = -1;
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (uint32(tailView, offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) return false;

  const diskNumber = tailView.getUint16(endOffset + 4, true);
  const directoryDisk = tailView.getUint16(endOffset + 6, true);
  const diskEntries = tailView.getUint16(endOffset + 8, true);
  const totalEntries = tailView.getUint16(endOffset + 10, true);
  const directorySize = uint32(tailView, endOffset + 12);
  const directoryOffset = uint32(tailView, endOffset + 16);
  const commentLength = tailView.getUint16(endOffset + 20, true);
  const absoluteEndOffset = file.size - tailSize + endOffset;
  if (diskNumber !== 0 || directoryDisk !== 0 || diskEntries !== totalEntries || totalEntries < 3 || totalEntries > MAX_DOCX_ENTRIES) return false;
  if ([diskEntries, totalEntries].includes(0xffff) || directorySize === 0xffffffff || directoryOffset === 0xffffffff) return false;
  if (endOffset + 22 + commentLength > tail.length || directorySize > 2 * 1024 * 1024 || directoryOffset + directorySize !== absoluteEndOffset) return false;

  const directory = new Uint8Array(await file.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer());
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const required = new Set(["[content_types].xml", "_rels/.rels", "word/document.xml"]);
  const localEntries: Array<{ name: string; offset: number }> = [];
  let totalUncompressed = 0;
  let offset = 0;

  try {
    for (let index = 0; index < totalEntries; index += 1) {
      if (offset + 46 > directory.length || uint32(view, offset) !== 0x02014b50) return false;
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const compressedSize = uint32(view, offset + 20);
      const uncompressedSize = uint32(view, offset + 24);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const entryCommentLength = view.getUint16(offset + 32, true);
      const localOffset = uint32(view, offset + 42);
      const next = offset + 46 + nameLength + extraLength + entryCommentLength;
      if (nameLength === 0 || next > directory.length || (flags & 0x0001) !== 0 || ![0, 8].includes(method)) return false;
      if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) return false;
      if (localOffset >= directoryOffset) return false;
      const name = decoder.decode(directory.subarray(offset + 46, offset + 46 + nameLength));
      const lowerName = name.toLowerCase();
      if (!safeZipPath(name)) return false;
      if (lowerName === "word/vbaproject.bin" || lowerName.startsWith("word/activex/") || lowerName.startsWith("word/embeddings/")) return false;
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > MAX_DOCX_UNCOMPRESSED_BYTES) return false;
      if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_DOCX_COMPRESSION_RATIO) return false;
      if (required.has(lowerName)) localEntries.push({ name, offset: localOffset });
      required.delete(lowerName);
      offset = next;
    }
  } catch {
    return false;
  }
  if (required.size > 0 || localEntries.length !== 3 || offset !== directory.length) return false;

  for (const entry of localEntries) {
    const header = new Uint8Array(await file.slice(entry.offset, entry.offset + 30 + 512).arrayBuffer());
    if (header.length < 30) return false;
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (uint32(headerView, 0) !== 0x04034b50) return false;
    const nameLength = headerView.getUint16(26, true);
    const extraLength = headerView.getUint16(28, true);
    if (nameLength === 0 || 30 + nameLength + extraLength > header.length) return false;
    try {
      if (decoder.decode(header.subarray(30, 30 + nameLength)) !== entry.name) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function hasExpectedSignature(file: File, extension: keyof typeof fileTypes): Promise<boolean> {
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (extension === "pdf") return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  if (extension === "doc") return [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, index) => bytes[index] === byte);
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04 && await validateDocxArchive(file);
}

export async function validateFiles(formData: FormData, support: unknown): Promise<Array<{ category: StoredAttachment["category"]; file: File; extension: keyof typeof fileTypes }>> {
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

export async function validateEmploymentResume(formData: FormData, enabled: boolean): Promise<File | null> {
  const entries = formData.getAll("resume");
  if (entries.length > 1) throw new RequestError(400, "TOO_MANY_FILES", "Only one résumé may be attached.");
  if (!entries.length) return null;
  const resume = entries[0];
  if (!(resume instanceof File)) throw new RequestError(400, "INVALID_FILE", "The attached résumé is invalid.");
  if (!enabled) {
    throw new RequestError(400, "EMPLOYMENT_RESUME_UPLOADS_DISABLED", "Résumé uploads are not currently available. Please submit without an attachment.");
  }
  if (resume.size < 5 || resume.size > MAX_RESUME_BYTES) {
    throw new RequestError(400, "INVALID_FILE_SIZE", "The résumé must be a PDF no larger than 5 MB.");
  }
  if (!/\.pdf$/i.test(resume.name)) throw new RequestError(400, "INVALID_FILE_TYPE", "The résumé must be a PDF file.");
  if (resume.type && !["application/pdf", "application/octet-stream"].includes(resume.type)) {
    throw new RequestError(400, "INVALID_FILE_TYPE", "The résumé type does not match its filename.");
  }
  const bytes = new Uint8Array(await resume.slice(0, 5).arrayBuffer());
  if (bytes.length < 5 || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46 || bytes[4] !== 0x2d) {
    throw new RequestError(400, "INVALID_FILE_CONTENT", "The résumé contents do not match a PDF file.");
  }
  return resume;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function enforceRateLimits(supabase: SupabaseClient, request: Request, email: unknown): Promise<void> {
  // Supabase's gateway supplies cf-connecting-ip. Never trust a caller-supplied
  // forwarding header. Missing gateway data shares a conservative fallback.
  const ip = trustedClientIp(request) || "gateway-ip-unavailable";
  const salt = requiredEnv("RATE_LIMIT_SALT");
  const keys = [
    [await sha256(`${salt}:ip:${ip}`), 5, 900],
    [await sha256(`${salt}:email:${String(email)}`), 3, 3600]
  ] as const;
  for (const [rateKey, limit, windowSeconds] of keys) {
    const result = await supabase.rpc("enforce_form_submission_rate_limit", {
      p_rate_key: rateKey,
      p_limit: limit,
      p_window_seconds: windowSeconds
    });
    if (result.error) throw new Error("Rate limit service unavailable");
    if (result.data !== true) {
      throw new RequestError(429, "RATE_LIMITED", "Too many submissions. Please wait before trying again.");
    }
  }
}

export function trustedClientIp(request: Request): string | null {
  const value = request.headers.get("cf-connecting-ip")?.trim().toLowerCase() || "";
  if (!value || value.length > 45) return null;
  const ipv4 = value.split(".");
  if (ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return value;
  if (value.includes(":") && /^[0-9a-f:]+$/.test(value) && !value.includes(":::")) return value;
  return null;
}

async function verifyTurnstile(token: string, request: Request, origin: string, expectedAction = "intake"): Promise<void> {
  if (!token || token.length > 2048) throw new RequestError(400, "SECURITY_CHECK_REQUIRED", "Please complete the security check.");
  const body = new URLSearchParams({ secret: requiredEnv("TURNSTILE_SECRET_KEY"), response: token });
  const ip = trustedClientIp(request);
  if (ip) body.set("remoteip", ip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const result = await response.json().catch(() => null) as { success?: boolean; hostname?: string; action?: string } | null;
  const expectedHostname = new URL(origin).hostname;
  if (!response.ok || !result?.success || (result.hostname && result.hostname !== expectedHostname) || (result.action && result.action !== expectedAction)) {
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

async function sendNotification(data: JsonRecord, attachmentCount: number, submissionId: string | number): Promise<NotificationResult> {
  const content = emailContent(data, attachmentCount, submissionId);
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requiredEnv("RESEND_API_KEY")}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `pure-form/${submissionId}`
      },
      body: JSON.stringify({
        from: NOTIFICATION_FROM,
        to: [NOTIFICATION_TO],
        reply_to: String(data.email),
        subject: content.subject,
        html: content.html,
        text: content.text
      }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS)
    });
    const result = await response.json().catch(() => null) as { id?: unknown; name?: unknown } | null;
    return {
      sent: response.ok && typeof result?.id === "string" && result.id.length > 0,
      providerId: response.ok && typeof result?.id === "string" ? result.id : null,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500 ||
        (response.status === 409 && result?.name === "concurrent_idempotent_requests")
    };
  } catch {
    return { sent: false, providerId: null, retryable: true };
  }
}

function employmentEmailContent(data: JsonRecord, hasResume: boolean, applicationId: string | number): { subject: string; html: string; text: string } {
  const fields = [
    ["First name", data.firstName],
    ["Last name", data.lastName],
    ["Email", data.email],
    ["Phone", data.phone],
    ["Previous support experience", data.previousExperience],
    ["Experience", data.experience || "Not provided"],
    ["Why they are interested", data.interestReason || "Not provided"]
  ];
  const rows = fields.map(([label, value]) => `<tr><th style="padding:10px 12px;text-align:left;vertical-align:top;border-bottom:1px solid #e7edf1;color:#1D252D;width:34%;font-size:14px">${escapeHtml(label)}</th><td style="padding:10px 12px;border-bottom:1px solid #e7edf1;color:#020A0A;font-size:14px;white-space:pre-wrap">${escapeHtml(value)}</td></tr>`).join("");
  const resumeNotice = hasResume
    ? '<div style="margin:20px 0;padding:14px 16px;border-left:4px solid #FF5900;background:#fff5ef;color:#1D252D"><strong>A private résumé was stored.</strong><br>It is not attached to this email. Access it only through the approved private review process.</div>'
    : "";
  const subject = "New Pure Coaching employment expression of interest";
  const html = `<!doctype html><html><body style="margin:0;background:#f4f7f9;font-family:Arial,sans-serif;color:#020A0A"><div style="max-width:680px;margin:0 auto;padding:28px 16px"><div style="height:8px;background:#FF5900;border-radius:12px 12px 0 0"></div><div style="background:#fff;padding:28px;border-radius:0 0 12px 12px"><p style="margin:0 0 8px;color:#FF5900;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase">Pure Coaching website</p><h1 style="margin:0 0 8px;color:#1D252D;font-size:26px">New employment expression of interest</h1><p style="margin:0 0 22px;color:#42515c">Application reference: ${escapeHtml(applicationId)}</p>${resumeNotice}<table role="presentation" style="width:100%;border-collapse:collapse;background:#f8fbfd;border:1px solid #B7DCF6;border-radius:8px">${rows}</table><p style="margin:22px 0 0;color:#5d6971;font-size:12px">This notification contains personal information. Handle it according to Pure Coaching's privacy and retention procedures.</p></div></div></body></html>`;
  const text = [subject, `Application reference: ${applicationId}`, "", ...fields.map(([label, value]) => `${label}: ${value}`), "", hasResume ? "A private résumé is stored in Supabase. It is not attached to this email." : ""].filter(Boolean).join("\n");
  return { subject, html, text };
}

async function sendEmploymentNotification(data: JsonRecord, hasResume: boolean, applicationId: string | number): Promise<NotificationResult> {
  const content = employmentEmailContent(data, hasResume, applicationId);
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requiredEnv("RESEND_API_KEY")}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `pure-employment/${applicationId}`
      },
      body: JSON.stringify({
        from: NOTIFICATION_FROM,
        to: [NOTIFICATION_TO],
        reply_to: String(data.email),
        subject: content.subject,
        html: content.html,
        text: content.text
      }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS)
    });
    const result = await response.json().catch(() => null) as { id?: unknown; name?: unknown } | null;
    return {
      sent: response.ok && typeof result?.id === "string" && result.id.length > 0,
      providerId: response.ok && typeof result?.id === "string" ? result.id : null,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500 ||
        (response.status === 409 && result?.name === "concurrent_idempotent_requests")
    };
  } catch {
    return { sent: false, providerId: null, retryable: true };
  }
}

async function updateOne(supabase: SupabaseClient, submissionId: string | number, values: JsonRecord): Promise<void> {
  const result = await supabase.from("form_submissions").update(values).eq("id", submissionId).select("id").single();
  if (result.error || !result.data) throw new Error("Submission state update failed");
}

export async function cleanupIncompleteSubmission(
  supabase: SupabaseClient,
  submissionId: string | number,
  attachments: StoredAttachment[]
): Promise<boolean> {
  const paths = attachments.map(({ path }) => path);
  if (paths.length) {
    const removal = await supabase.storage.from(BUCKET).remove(paths);
    if (removal.error) return false;

    for (const category of ["ndisPlanDocument", "supportingReports"] as const) {
      const expectedNames = new Set(attachments.filter((item) => item.category === category).map((item) => item.path.split("/").pop()));
      if (!expectedNames.size) continue;
      const listing = await supabase.storage.from(BUCKET).list(`${submissionId}/${category}`, { limit: MAX_REPORTS + 1 });
      if (listing.error || !listing.data || listing.data.some((item) => expectedNames.has(item.name))) return false;
    }
  }

  const deletion = await supabase.from("form_submissions").delete().eq("id", submissionId).select("id").single();
  return !deletion.error && Boolean(deletion.data);
}

async function updateEmploymentApplication(supabase: SupabaseClient, id: string | number, values: JsonRecord): Promise<void> {
  const result = await supabase.from("employment_applications").update(values).eq("id", id).select("id").single();
  if (result.error || !result.data) throw new Error("Employment application state update failed");
}

async function cleanupEmploymentApplication(supabase: SupabaseClient, id: string | number, resumePath: string | null): Promise<boolean> {
  if (resumePath) {
    const removal = await supabase.storage.from(EMPLOYMENT_BUCKET).remove([resumePath]);
    if (removal.error) return false;
    const folder = resumePath.slice(0, resumePath.lastIndexOf("/"));
    const listing = await supabase.storage.from(EMPLOYMENT_BUCKET).list(folder, { limit: 2 });
    if (listing.error || listing.data?.some((item) => item.name === "resume.pdf")) return false;
  }
  const deletion = await supabase.from("employment_applications").delete().eq("id", id).select("id").single();
  return !deletion.error && Boolean(deletion.data);
}

async function handleEmploymentSubmission(formData: FormData, request: Request, origin: string, supabase: SupabaseClient): Promise<Response> {
  let applicationId: string | number | null = null;
  let resumePath: string | null = null;
  let storageFinalized = false;
  try {
    const payloadText = formData.get("payload");
    if (typeof payloadText !== "string" || payloadText.length > 20000) {
      throw new RequestError(400, "INVALID_PAYLOAD", "The submitted form data is invalid.");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(payloadText); } catch { throw new RequestError(400, "INVALID_PAYLOAD", "The submitted form data is invalid."); }
    const data = validateEmploymentPayload(parsed);
    const resume = await validateEmploymentResume(formData, employmentResumeUploadsEnabled());
    await verifyTurnstile(String(formData.get("turnstileToken") || ""), request, origin, EMPLOYMENT_FORM_TYPE);
    await enforceRateLimits(supabase, request, data.email);

    resumePath = resume ? employmentResumeObjectPath(data) : null;
    const inserted = await supabase.from("employment_applications").insert({
      client_submission_id: data.clientSubmissionId,
      first_name: data.firstName,
      last_name: data.lastName,
      email: data.email,
      phone: data.phone,
      previous_support_experience: data.previousExperience === "Yes",
      experience_description: data.experience || null,
      motivation: data.interestReason || null,
      resume_object_path: resumePath,
      email_status: "pending",
      email_attempt_count: 0,
      email_retryable: false
    }).select("id").single();
    if (inserted.error) {
      if (inserted.error.code === "23505") {
        throw new RequestError(409, "DUPLICATE_SUBMISSION", "This submission identifier has already been used. Please start a new submission.");
      }
      throw new Error("Employment application storage failed");
    }
    if (typeof inserted.data?.id !== "string" && typeof inserted.data?.id !== "number") {
      throw new Error("Employment application storage returned an invalid identifier");
    }
    applicationId = inserted.data.id;

    if (resume && resumePath) {
      const upload = await supabase.storage.from(EMPLOYMENT_BUCKET).upload(resumePath, resume, {
        contentType: "application/pdf",
        upsert: false,
        cacheControl: "0"
      });
      if (upload.error) throw new Error("Private résumé storage failed");
    }
    storageFinalized = true;

    const attemptedAt = new Date().toISOString();
    await updateEmploymentApplication(supabase, applicationId, {
      email_attempt_count: 1,
      email_last_attempt_at: attemptedAt,
      email_retryable: false
    });
    const notification = await sendEmploymentNotification(data, Boolean(resume), applicationId);
    await updateEmploymentApplication(supabase, applicationId, {
      email_status: notification.sent ? "sent" : "failed",
      email_sent_at: notification.sent ? new Date().toISOString() : null,
      email_provider_id: notification.providerId,
      email_retryable: !notification.sent && notification.retryable
    });
    if (!notification.sent) console.error("Employment notification delivery failed", { applicationId, retryable: notification.retryable });
    return jsonResponse(origin, 200, { ok: true });
  } catch (error) {
    if (applicationId !== null && !storageFinalized) {
      try {
        const cleaned = await cleanupEmploymentApplication(supabase, applicationId, resumePath);
        if (!cleaned) console.error("Employment application cleanup requires administrative recovery", { applicationId });
      } catch {
        console.error("Employment application cleanup requires administrative recovery", { applicationId });
      }
    }
    throw error;
  }
}

export async function handleRequest(request: Request): Promise<Response> {
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

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    return jsonResponse(origin, 415, { ok: false, error: "The submission format is not supported." });
  }
  const contentLengthHeader = request.headers.get("content-length") || "";
  if (!/^\d+$/.test(contentLengthHeader)) {
    return jsonResponse(origin, 411, { ok: false, error: "A bounded submission size is required." });
  }
  const contentLength = Number(contentLengthHeader);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > MAX_REQUEST_BYTES) {
    return jsonResponse(origin, 413, { ok: false, error: "The submission is too large." });
  }

  let submissionId: string | number | null = null;
  let plannedAttachments: StoredAttachment[] = [];
  let supabase: SupabaseClient | null = null;
  let storageFinalized = false;
  try {
    supabase = createClient(requiredEnv("SUPABASE_URL"), supabaseAdminKey(), {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const formData = await request.formData();
    const formType = formData.get("formType");
    if (formType === EMPLOYMENT_FORM_TYPE) {
      return await handleEmploymentSubmission(formData, request, origin, supabase);
    }
    if (formType !== FORM_TYPE) throw new RequestError(400, "INVALID_FORM_TYPE", "This form type is not supported.");
    const uploadsEnabled = documentUploadsEnabled();
    enforceDocumentUploadSetting(formData, uploadsEnabled);

    const payloadText = formData.get("payload");
    if (typeof payloadText !== "string" || payloadText.length > 20000) throw new RequestError(400, "INVALID_PAYLOAD", "The submitted form data is invalid.");
    let parsed: unknown;
    try { parsed = JSON.parse(payloadText); } catch { throw new RequestError(400, "INVALID_PAYLOAD", "The submitted form data is invalid."); }
    const data = validatePayload(parsed);
    const files = uploadsEnabled ? await validateFiles(formData, data.support) : [];
    await verifyTurnstile(String(formData.get("turnstileToken") || ""), request, origin);

    await enforceRateLimits(supabase, request, data.email);

    const inserted = await supabase.from("form_submissions").insert({
      form_type: FORM_TYPE,
      form_data: data,
      attachments: [],
      email_status: "pending",
      email_sent_at: null,
      email_attempt_count: 0,
      email_last_attempt_at: null,
      email_provider_id: null,
      email_retryable: false
    }).select("id").single();
    if (inserted.error) {
      if (inserted.error.code === "23505") {
        throw new RequestError(409, "DUPLICATE_SUBMISSION", "This submission identifier has already been used. Please start a new submission.");
      }
      throw new Error("Submission storage failed");
    }
    const storedSubmissionId = inserted.data?.id;
    if (typeof storedSubmissionId !== "string" && typeof storedSubmissionId !== "number") {
      throw new Error("Submission storage returned an invalid identifier");
    }
    submissionId = storedSubmissionId;

    plannedAttachments = files.map((entry) => {
      const filename = storedDocumentFilename(data, entry.category, entry.extension);
      const path = `${storedSubmissionId}/${entry.category}/${filename}`;
      return { category: entry.category, bucket: BUCKET, path, contentType: fileTypes[entry.extension], size: entry.file.size, state: "pending" as const };
    });
    await updateOne(supabase, storedSubmissionId, { attachments: plannedAttachments });

    for (const [index, entry] of files.entries()) {
      const path = plannedAttachments[index].path;
      const upload = await supabase.storage.from(BUCKET).upload(path, entry.file, { contentType: fileTypes[entry.extension], upsert: false, cacheControl: "0" });
      if (upload.error) throw new Error("Private document storage failed");
    }

    const storedAttachments = plannedAttachments.map((attachment) => ({ ...attachment, state: "stored" as const }));
    await updateOne(supabase, storedSubmissionId, { attachments: storedAttachments });
    storageFinalized = true;

    const attemptedAt = new Date().toISOString();
    await updateOne(supabase, storedSubmissionId, { email_attempt_count: 1, email_last_attempt_at: attemptedAt, email_retryable: false });
    const notification = await sendNotification(data, storedAttachments.length, storedSubmissionId);
    await updateOne(supabase, storedSubmissionId, {
      email_status: notification.sent ? "sent" : "failed",
      email_sent_at: notification.sent ? new Date().toISOString() : null,
      email_provider_id: notification.providerId,
      email_retryable: !notification.sent && notification.retryable
    });
    if (!notification.sent) console.error("Notification delivery failed", { submissionId, retryable: notification.retryable });

    return jsonResponse(origin, 200, { ok: true });
  } catch (error) {
    if (submissionId !== null && supabase && !storageFinalized) {
      try {
        const cleaned = await cleanupIncompleteSubmission(supabase, submissionId, plannedAttachments);
        if (!cleaned) console.error("Submission cleanup requires administrative recovery", { submissionId });
      } catch {
        console.error("Submission cleanup requires administrative recovery", { submissionId });
      }
    }
    if (error instanceof RequestError) return jsonResponse(origin, error.status, { ok: false, code: error.code, error: error.message });
    console.error("Form submission failed", { submissionId, errorType: error instanceof Error ? error.name : "Unknown" });
    return jsonResponse(origin, 500, { ok: false, error: "We could not securely store your enquiry. Please try again." });
  }
}

export default { fetch: handleRequest };
