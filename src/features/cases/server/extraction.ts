import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import { extractText } from "unpdf";
import { z } from "zod";

import { serviceTypeSchema } from "~/features/providers";
import { db } from "~/server/db";
import { caseDocuments, cases, contractTerms, providers } from "~/server/db/schema";
import { type CallOverrides, type ChatMessage, completeJson } from "~/server/model/adapter";
import { createStorage, type StorageClient } from "~/server/storage";
import { redact, redactJson, storeSecret } from "~/server/vault";
import { ToolError } from "./errors";
import { persistRecommendation, type Recommendation } from "./recommendation";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .default(null);

/** The bill facts the model returns. PII fields go to the vault, never to storage. */
export const ExtractionSchema = z.object({
  provider_name: z.string().max(120).nullable().default(null),
  service_type: serviceTypeSchema.nullable().default(null),
  account_no: z.string().max(64).nullable().default(null),
  holder_full_name: z.string().max(120).nullable().default(null),
  monthly_fee_cents: z.number().int().min(0).nullable().default(null),
  contract_start: dateSchema,
  contract_end_date: dateSchema,
  min_term_months: z.number().int().min(0).max(600).nullable().default(null),
  etf_clause_text: z.string().max(2000).nullable().default(null),
  notice_days: z.number().int().min(0).max(3660).nullable().default(null),
  equipment: z.array(z.string().max(120)).max(20).default([]),
  bundle_links: z.array(z.string().max(200)).max(20).default([]),
  evidence: z
    .array(z.object({ page: z.number().int().min(1), quote: z.string().max(500) }))
    .max(30)
    .default([]),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

const EXTRACT_SYSTEM =
  "Extract contract facts from this bill for a cancellation assistant. " +
  "Use null for anything the bill does not state. " +
  "Quote the exact bill sentence behind each fact in evidence.";

export interface ExtractionDeps {
  storage?: StorageClient;
  model?: CallOverrides;
}

function isPdf(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  );
}

function imageContentType(bytes: Uint8Array): "image/png" | "image/jpeg" | null {
  if (
    bytes.length > 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  // Copy: PDF.js transfers (neuters) the buffer it is given, and the caller
  // still needs these bytes for scan extraction and the sha256 below.
  const view = bytes.slice();
  try {
    const { text } = await extractText(view, { mergePages: false });
    return text;
  } catch {
    throw new ToolError("VALIDATION", "Could not read the PDF text layer");
  }
}

function decodeDataUrl(storageKey: string): Uint8Array | null {
  if (!storageKey.startsWith("data:")) return null;
  const payload = storageKey.split(",")[1] ?? "";
  return new Uint8Array(Buffer.from(payload, "base64"));
}

/** Filled scalar/vector fields; used for the evidence confidence rule. */
function filledFieldCount(extraction: Extraction): number {
  let count = 0;
  if (extraction.provider_name) count++;
  if (extraction.service_type) count++;
  if (extraction.account_no) count++;
  if (extraction.holder_full_name) count++;
  if (extraction.monthly_fee_cents !== null) count++;
  if (extraction.contract_start) count++;
  if (extraction.contract_end_date) count++;
  if (extraction.min_term_months !== null) count++;
  if (extraction.etf_clause_text) count++;
  if (extraction.notice_days !== null) count++;
  if (extraction.equipment.length > 0) count++;
  if (extraction.bundle_links.length > 0) count++;
  return count;
}

function evidencePages(
  extraction: Extraction,
  documentId: string,
): Array<{ document_id: string; page: number }> {
  const pages = [...new Set(extraction.evidence.map((entry) => entry.page))].sort((a, b) => a - b);
  return pages.map((page) => ({ document_id: documentId, page }));
}

export interface ExtractionResult {
  documentId: string;
  providerMatched: boolean;
  confidence: number;
  recommendation: Recommendation | null;
}

/**
 * `documents.extract`: read one bill into vault secrets, contract terms and
 * a stored recommendation. Text-layer PDFs are redacted before the
 * contributor-tier model sees them; images go to the standard tier as image
 * parts. `account_no` and `holder_full_name` move straight to the vault and
 * only their tokens reach storage or logs.
 */
export async function extractDocument(
  input: { caseId: string; documentId: string; ownerKey: string | null },
  deps: ExtractionDeps = {},
): Promise<ExtractionResult> {
  const storage = deps.storage ?? createStorage();
  const [c] = await db.select().from(cases).where(eq(cases.id, input.caseId)).limit(1);
  if (!c) throw new ToolError("NOT_FOUND", "Case not found");
  const [doc] = await db
    .select()
    .from(caseDocuments)
    .where(and(eq(caseDocuments.caseId, input.caseId), eq(caseDocuments.id, input.documentId)))
    .limit(1);
  if (!doc) throw new ToolError("NOT_FOUND", "Document not found");

  const bytes = decodeDataUrl(doc.storageKey) ?? (await readBytes(storage, doc.storageKey));
  const extraction = await runModel(c.holderId, bytes, input.ownerKey, deps.model);

  // Vault first: PII is stored before anything else runs, so the redact pass
  // below already knows every new secret.
  const tokens: { accountNo: string | null; holderName: string | null } = {
    accountNo: null,
    holderName: null,
  };
  if (extraction.account_no) {
    const secret = await storeSecret(db, {
      holderId: c.holderId,
      kind: "ACCOUNT_NO",
      value: extraction.account_no,
    });
    tokens.accountNo = `{{vault:ACCOUNT_NO:${secret.id}}}`;
  }
  if (extraction.holder_full_name) {
    const secret = await storeSecret(db, {
      holderId: c.holderId,
      kind: "FULL_NAME",
      value: extraction.holder_full_name,
    });
    tokens.holderName = `{{vault:FULL_NAME:${secret.id}}}`;
  }

  const extracted = {
    ...extraction,
    account_no: tokens.accountNo,
    holder_full_name: tokens.holderName,
  };
  const scrubbed = (await redactJson(db, extracted, c.holderId)) as typeof extracted;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await db
    .update(caseDocuments)
    .set({ sha256, extracted: scrubbed })
    .where(eq(caseDocuments.id, doc.id));

  const confidence =
    extraction.evidence.length === 0 && filledFieldCount(extraction) > 0 ? 70 : 100;
  await db
    .insert(contractTerms)
    .values({
      caseId: c.id,
      contractEndDate: extraction.contract_end_date,
      minTermMonths: extraction.min_term_months,
      monthlyFeeCents: extraction.monthly_fee_cents,
      currency: "SGD",
      noticeDays: extraction.notice_days,
      equipment: extraction.equipment,
      bundleLinks: extraction.bundle_links,
      confidence,
      evidence: evidencePages(extraction, doc.id),
    })
    .onConflictDoUpdate({
      target: contractTerms.caseId,
      set: {
        contractEndDate: extraction.contract_end_date,
        minTermMonths: extraction.min_term_months,
        monthlyFeeCents: extraction.monthly_fee_cents,
        currency: "SGD",
        noticeDays: extraction.notice_days,
        equipment: extraction.equipment,
        bundleLinks: extraction.bundle_links,
        confidence,
        evidence: evidencePages(extraction, doc.id),
      },
    });

  const providerId = await resolveProvider(extraction.provider_name);
  if (!providerId) {
    return { documentId: doc.id, providerMatched: false, confidence, recommendation: null };
  }
  const serviceType = extraction.service_type ?? (await providerCategory(providerId));
  await db.update(cases).set({ providerId, serviceType }).where(eq(cases.id, c.id));
  const recommendation = await persistRecommendation(db, c.id, extraction.etf_clause_text);
  return { documentId: doc.id, providerMatched: true, confidence, recommendation };
}

async function readBytes(storage: StorageClient, key: string): Promise<Uint8Array> {
  try {
    return await storage.get(key);
  } catch {
    throw new ToolError("INTERNAL_ERROR", "Could not download the document");
  }
}

async function runModel(
  holderId: string,
  bytes: Uint8Array,
  ownerKey: string | null,
  modelOverrides: CallOverrides | undefined,
): Promise<Extraction> {
  const imageType = imageContentType(bytes);
  if (imageType) {
    const dataUrl = `data:${imageType};base64,${Buffer.from(bytes).toString("base64")}`;
    const messages: ChatMessage[] = [
      { role: "system", content: EXTRACT_SYSTEM, redacted: true },
      { role: "user", content: [{ type: "image", dataUrl }], redacted: false },
    ];
    const { data } = await completeJson(
      { tier: "standard", messages, ownerKey },
      ExtractionSchema,
      modelOverrides,
    );
    return data;
  }
  if (!isPdf(bytes)) {
    throw new ToolError("VALIDATION", "The document is not a PDF, PNG or JPEG");
  }
  const pages = await pdfPages(bytes);
  if (!pages.some((text) => text.trim())) {
    return runScanModel(bytes, ownerKey, modelOverrides);
  }
  const numbered = pages
    .map((text, index) => `--- Page ${index + 1} ---\n${text.trim()}`)
    .join("\n\n");
  const redacted = await redact(db, numbered, holderId);
  const messages: ChatMessage[] = [
    { role: "system", content: EXTRACT_SYSTEM, redacted: true },
    { role: "user", content: redacted, redacted: true },
  ];
  const { data } = await completeJson(
    { tier: "contributor", messages, ownerKey },
    ExtractionSchema,
    modelOverrides,
  );
  return data;
}

/** At most this many page scans ride in one extraction call (model context). */
const MAX_SCAN_IMAGES = 10;

/** Width times height from an image dict, or 0 when unreadable. */
function imagePixels(dict: PDFDict): number {
  const width = dict.get(PDFName.of("Width"));
  const height = dict.get(PDFName.of("Height"));
  if (!(width instanceof PDFNumber) || !(height instanceof PDFNumber)) return 0;
  const pixels = width.asNumber() * height.asNumber();
  return Number.isFinite(pixels) && pixels > 0 ? pixels : 0;
}

/**
 * One JPEG scan per page, in page order: the largest DCT image on the page,
 * preferring color over grayscale masks on ties. Raw DCT stream bytes are
 * complete JPEG files, so the pages pass through without re-encoding (pure
 * pdf-lib, no canvas runtime). Non-JPEG images are skipped: scanners emit
 * JPEG, and anything else has no readable raster to send.
 */
async function pdfPageScans(bytes: Uint8Array): Promise<Uint8Array[]> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch {
    throw new ToolError("VALIDATION", "Could not read the PDF");
  }
  const scans: Uint8Array[] = [];
  for (const page of doc.getPages()) {
    if (scans.length >= MAX_SCAN_IMAGES) break;
    const resources = page.node.get(PDFName.of("Resources"));
    if (!resources) continue;
    const res = doc.context.lookup(resources);
    if (!(res instanceof PDFDict)) continue;
    const xobjects = res.get(PDFName.of("XObject"));
    if (!xobjects) continue;
    const xo = doc.context.lookup(xobjects);
    if (!(xo instanceof PDFDict)) continue;
    let best: { bytes: Uint8Array; pixels: number; color: boolean } | null = null;
    for (const [, ref] of xo.entries()) {
      const obj = doc.context.lookup(ref);
      if (!(obj instanceof PDFRawStream)) continue;
      const dict = obj.dict;
      if (dict.get(PDFName.of("Subtype"))?.toString() !== "/Image") continue;
      if (!dict.get(PDFName.of("Filter"))?.toString().includes("DCTDecode")) continue;
      const contents = obj.getContents();
      if (imageContentType(contents) !== "image/jpeg") continue;
      const candidate = {
        bytes: contents,
        pixels: imagePixels(dict),
        color: (dict.get(PDFName.of("ColorSpace"))?.toString() ?? "").includes("RGB"),
      };
      if (
        !best ||
        candidate.pixels > best.pixels ||
        (candidate.pixels === best.pixels && candidate.color && !best.color)
      ) {
        best = candidate;
      }
    }
    if (best) scans.push(best.bytes);
  }
  return scans;
}

/**
 * A textless PDF goes to the model as one image part per page on the
 * standard tier, in a single call: a 3-page bill costs one model call (two
 * at most, when the JSON retry fires).
 */
async function runScanModel(
  bytes: Uint8Array,
  ownerKey: string | null,
  modelOverrides: CallOverrides | undefined,
): Promise<Extraction> {
  const scans = await pdfPageScans(bytes);
  if (scans.length === 0) {
    throw new ToolError("VALIDATION", "The PDF has no readable text or images");
  }
  const messages: ChatMessage[] = [
    { role: "system", content: EXTRACT_SYSTEM, redacted: true },
    {
      role: "user",
      content: [
        { type: "text", text: "The bill pages follow in order, one image per page." },
        ...scans.map((scan) => ({
          type: "image" as const,
          dataUrl: `data:image/jpeg;base64,${Buffer.from(scan).toString("base64")}`,
        })),
      ],
      redacted: false,
    },
  ];
  const { data } = await completeJson(
    { tier: "standard", messages, ownerKey },
    ExtractionSchema,
    modelOverrides,
  );
  return data;
}

async function resolveProvider(providerName: string | null): Promise<string | null> {
  if (!providerName) return null;
  const slug = providerName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const rows = await db.select().from(providers).orderBy(providers.slug);
  const bySlug = rows.find((row) => row.slug === slug);
  if (bySlug) return bySlug.id;
  const wanted = providerName.trim().toLowerCase();
  return rows.find((row) => row.name.toLowerCase() === wanted)?.id ?? null;
}

async function providerCategory(
  providerId: string,
): Promise<typeof cases.$inferInsert.serviceType> {
  const [provider] = await db
    .select({ category: providers.category })
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1);
  return provider?.category ?? null;
}
