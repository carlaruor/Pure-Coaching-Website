import {
  cleanupIncompleteSubmission,
  documentUploadsEnabled,
  enforceDocumentUploadSetting,
  parseSupabaseSecretKeys,
  storedDocumentFilename,
  type StoredAttachment,
  trustedClientIp,
  validateDocxArchive,
  validateFiles,
  validatePayload
} from "./index.ts";

function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertThrows(action: () => unknown, expected: string): void {
  try {
    action();
  } catch (error) {
    assert(error instanceof Error && error.message.includes(expected), `Expected error containing ${expected}`);
    return;
  }
  throw new Error(`Expected error containing ${expected}`);
}

function uint16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function uint32(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function bytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function syntheticZip(names: string[]): File {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const name of names) {
    const nameBytes = encoder.encode(name);
    const content = encoder.encode("synthetic");
    const local = bytes(
      uint32(0x04034b50), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0),
      uint32(0), uint32(content.length), uint32(content.length), uint16(nameBytes.length), uint16(0), nameBytes, content
    );
    const central = bytes(
      uint32(0x02014b50), uint16(20), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0),
      uint32(0), uint32(content.length), uint32(content.length), uint16(nameBytes.length), uint16(0), uint16(0),
      uint16(0), uint16(0), uint32(0), uint32(localOffset), nameBytes
    );
    localParts.push(local);
    centralParts.push(central);
    localOffset += local.length;
  }
  const locals = bytes(...localParts);
  const central = bytes(...centralParts);
  const end = bytes(
    uint32(0x06054b50), uint16(0), uint16(0), uint16(names.length), uint16(names.length),
    uint32(central.length), uint32(locals.length), uint16(0)
  );
  return new File([bytes(locals, central, end).buffer as ArrayBuffer], "synthetic.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

function validPayload(): Record<string, unknown> {
  return {
    clientSubmissionId: "synthetic-submission-000001",
    contactFor: "Myself",
    support: "private",
    intent: "enquiry",
    firstName: "Synthetic",
    lastName: "Test",
    email: "synthetic@example.invalid",
    phone: "0400000000",
    ageRange: "25+",
    message: "Synthetic test only",
    preferredContact: "Email",
    contactTime: "",
    consent: true,
    website: ""
  };
}

Deno.test("parses the deployed SUPABASE_SECRET_KEYS dictionary", () => {
  assert(parseSupabaseSecretKeys('{"default":"sb_secret_synthetic"}') === "sb_secret_synthetic");
  assertThrows(() => parseSupabaseSecretKeys('{"other":"value"}'), "Missing default");
  assertThrows(() => parseSupabaseSecretKeys("not-json"), "SUPABASE_SECRET_KEYS");
});

Deno.test("uses only a valid gateway-supplied client IP", () => {
  assert(trustedClientIp(new Request("https://example.test", { headers: { "cf-connecting-ip": "203.0.113.8", "x-forwarded-for": "198.51.100.9" } })) === "203.0.113.8");
  assert(trustedClientIp(new Request("https://example.test", { headers: { "x-forwarded-for": "198.51.100.9" } })) === null);
  assert(trustedClientIp(new Request("https://example.test", { headers: { "cf-connecting-ip": "not-an-ip" } })) === null);
});

Deno.test("validates all fields before an idempotency claim", () => {
  assert(validatePayload(validPayload()).email === "synthetic@example.invalid");
  const invalid = { ...validPayload(), email: "not-an-email" };
  assertThrows(() => validatePayload(invalid), "valid email");
});

Deno.test("enables document uploads only for the exact true environment value", () => {
  assert(documentUploadsEnabled("true"));
  assert(!documentUploadsEnabled(undefined));
  assert(!documentUploadsEnabled("false"));
  assert(!documentUploadsEnabled("TRUE"));
  assert(!documentUploadsEnabled(" true "));
});

Deno.test("accepts attachment-free submissions and rejects direct files while uploads are disabled", () => {
  const withoutFiles = new FormData();
  withoutFiles.set("formType", "intake");
  enforceDocumentUploadSetting(withoutFiles, false);

  const withFile = new FormData();
  withFile.set("formType", "intake");
  withFile.set("unexpectedFile", new File(["synthetic"], "synthetic.pdf", { type: "application/pdf" }));
  assertThrows(() => enforceDocumentUploadSetting(withFile, false), "not currently available");
  enforceDocumentUploadSetting(withFile, true);
});

Deno.test("preserves existing document validation when uploads are enabled", async () => {
  const formData = new FormData();
  formData.set(
    "ndisPlanDocument",
    new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])], "synthetic.pdf", { type: "application/pdf" })
  );
  enforceDocumentUploadSetting(formData, true);
  const files = await validateFiles(formData, "ndis");
  assert(files.length === 1 && files[0].extension === "pdf");
});

Deno.test("names self-referral documents from the existing contact name", () => {
  const data = validatePayload(validPayload());
  const filename = storedDocumentFilename(
    data,
    "ndisPlanDocument",
    "pdf",
    new Date("2026-11-19T01:50:00.000Z"),
    "89a7d938"
  );
  assert(filename === "Synthetic_Test_2026-11-19_1150_NDIS_Plan_89a7d938.pdf", filename);
  const legacyDoc = storedDocumentFilename(data, "supportingReports", "doc", new Date("2026-11-19T01:50:00.000Z"), "27bc61ef");
  assert(legacyDoc === "Synthetic_Test_2026-11-19_1150_Supporting_Document_27bc61ef.doc", legacyDoc);
});

Deno.test("names third-party documents from participant fields and rejects missing participant names", () => {
  const data = validatePayload({
    ...validPayload(),
    contactFor: "Someone else",
    firstName: "Contact",
    lastName: "Person",
    role: "Support Coordinator",
    personFirstName: "Emma/../",
    personLastName: "Smíth"
  });
  const date = new Date("2026-11-19T01:50:00.000Z");
  const first = storedDocumentFilename(data, "supportingReports", "docx", date, "89a7d938");
  const second = storedDocumentFilename(data, "supportingReports", "docx", date, "27bc61ef");
  assert(first === "Emma_Smith_2026-11-19_1150_Supporting_Document_89a7d938.docx", first);
  assert(!first.includes("Contact_Person"), "The referrer's name must not be used for a participant document");
  assert(!first.includes("..") && !first.includes("/"), "The stored filename contains an unsafe path component");
  assert(second !== first, "Server-generated identifiers must prevent filename collisions");
  assertThrows(() => validatePayload({
    ...validPayload(),
    contactFor: "Someone else",
    role: "Support Coordinator"
  }), "personFirstName");
});

Deno.test("accepts a structurally valid DOCX and rejects misleading ZIP files", async () => {
  const valid = syntheticZip(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
  assert(await validateDocxArchive(valid));
  assert(!(await validateDocxArchive(syntheticZip(["[Content_Types].xml", "_rels/.rels", "other.xml"]))));
  assert(!(await validateDocxArchive(syntheticZip(["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/vbaProject.bin"]))));
});

Deno.test("rejects a ZIP-only file presented as DOCX", async () => {
  const formData = new FormData();
  formData.append("supportingReports", syntheticZip(["unrelated.txt"]));
  try {
    await validateFiles(formData, "ndis");
  } catch (error) {
    assert(error instanceof Error && error.message.includes("contents"));
    return;
  }
  throw new Error("Expected invalid DOCX content to be rejected");
});

Deno.test("does not delete the recovery record when Storage cleanup cannot be verified", async () => {
  let databaseDeleteCalled = false;
  const client = {
    storage: { from: () => ({
      remove: () => Promise.resolve({ data: null, error: new Error("synthetic failure") }),
      list: () => Promise.resolve({ data: [], error: null })
    }) },
    from: () => ({ delete: () => ({ eq: () => ({ select: () => ({ single: () => {
      databaseDeleteCalled = true;
      return Promise.resolve({ data: { id: "synthetic" }, error: null });
    } }) }) }) })
  };
  const attachments: StoredAttachment[] = [{
    category: "supportingReports",
    bucket: "referral-documents",
    path: "synthetic/supportingReports/file.docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 100,
    state: "pending"
  }];
  const cleaned = await cleanupIncompleteSubmission(client as never, "synthetic", attachments);
  assert(!cleaned);
  assert(!databaseDeleteCalled, "Recovery record must remain when private-object cleanup fails");
});

Deno.test("deletes the incomplete row only after private paths are confirmed absent", async () => {
  let databaseDeleteCalled = false;
  const client = {
    storage: { from: () => ({
      remove: () => Promise.resolve({ data: [], error: null }),
      list: () => Promise.resolve({ data: [], error: null })
    }) },
    from: () => ({ delete: () => ({ eq: () => ({ select: () => ({ single: () => {
      databaseDeleteCalled = true;
      return Promise.resolve({ data: { id: "synthetic" }, error: null });
    } }) }) }) })
  };
  const attachments: StoredAttachment[] = [{
    category: "supportingReports",
    bucket: "referral-documents",
    path: "synthetic/supportingReports/file.docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 100,
    state: "pending"
  }];
  const cleaned = await cleanupIncompleteSubmission(client as never, "synthetic", attachments);
  assert(cleaned);
  assert(databaseDeleteCalled);
});
