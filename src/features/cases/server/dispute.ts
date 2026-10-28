import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { PageSizes, PDFDocument, rgb, StandardFonts } from "pdf-lib";

import { type Database, db } from "~/server/db";
import {
  accountHolders,
  auditLogs,
  caseDocuments,
  cases,
  communications,
  mandates,
  providers,
  receipts,
} from "~/server/db/schema";
import { createStorage, documentKey, type StorageClient } from "~/server/storage";
import { getSecretValues, redact, secretToken } from "~/server/vault";

export interface DisputeInput {
  caseId: string;
  disputedChargeCents: number | null;
  currency?: string;
}

export interface DisputeDeps {
  storage?: StorageClient;
}

function formatCents(cents: number | null, currency: string): string {
  if (cents === null) return "as billed";
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

interface DisputeFacts {
  providerName: string;
  alias: string;
  fullNameToken: string;
  accountToken: string;
  referenceCode: string;
  effectiveDate: string;
  noticeDate: string;
  noticeMessageId: string;
  loaRef: string;
  timeline: Array<{ at: string; action: string }>;
  charge: string;
}

/** Cover letter plus the six required sections, tokenized for storage. */
function buildDisputeLines(facts: DisputeFacts): string[] {
  return [
    "Dispute package — unauthorised rebill",
    `To the card issuer: please dispute the charge below billed after cancellation.`,
    `Holder: ${facts.fullNameToken} (${facts.alias})`,
    `Provider: ${facts.providerName}`,
    `Account: ${facts.accountToken}`,
    `Cancellation receipt: ${facts.referenceCode}, effective ${facts.effectiveDate}`,
    `Termination notice: sent ${facts.noticeDate}, Message-ID ${facts.noticeMessageId}`,
    `Letter of authorisation: ${facts.loaRef}`,
    `Disputed charge: ${facts.charge}`,
    "Case timeline:",
    ...facts.timeline.map((entry) => `- ${entry.at}: ${entry.action}`),
  ];
}

async function renderPdf(lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [width, height] = PageSizes.A4;
  const margin = 56;
  let page = doc.addPage([width, height]);
  let y = height - margin;
  lines.forEach((line, index) => {
    const font = index === 0 ? bold : regular;
    const size = index === 0 ? 16 : 11;
    const words = line.split(" ");
    const wrapped: string[] = [];
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width - margin * 2 && current) {
        wrapped.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    if (current) wrapped.push(current);
    for (const row of wrapped) {
      if (y < margin + size) {
        page = doc.addPage([width, height]);
        y = height - margin;
      }
      page.drawText(row, { x: margin, y, font, size, color: rgb(0, 0, 0) });
      y -= size * 1.5;
    }
    y -= 4;
  });
  return doc.save();
}

async function collectFacts(
  conn: Database,
  input: DisputeInput,
): Promise<{ facts: DisputeFacts; secretIds: string[]; tokens: Map<string, string> }> {
  const [c] = await conn.select().from(cases).where(eq(cases.id, input.caseId)).limit(1);
  if (!c) throw new Error("Case not found");
  const [holder] = await conn
    .select()
    .from(accountHolders)
    .where(eq(accountHolders.id, c.holderId))
    .limit(1);
  const [provider] = c.providerId
    ? await conn.select().from(providers).where(eq(providers.id, c.providerId)).limit(1)
    : [];
  const [receipt] = await conn
    .select()
    .from(receipts)
    .where(eq(receipts.caseId, input.caseId))
    .limit(1);
  const notices = await conn
    .select()
    .from(communications)
    .where(and(eq(communications.caseId, input.caseId), eq(communications.channel, "EMAIL")));
  const notice = notices.find((row) => row.direction === "OUTBOUND") ?? notices[0];
  const [mandate] = await conn
    .select()
    .from(mandates)
    .where(eq(mandates.caseId, input.caseId))
    .limit(1);
  const timeline = await conn
    .select({ action: auditLogs.action, createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .where(eq(auditLogs.caseId, input.caseId));

  const { vaultSecrets } = await import("~/server/db/schema");
  const { desc, isNull } = await import("drizzle-orm");
  const [fullName] = await conn
    .select({ id: vaultSecrets.id })
    .from(vaultSecrets)
    .where(
      and(
        eq(vaultSecrets.holderId, c.holderId),
        eq(vaultSecrets.kind, "FULL_NAME"),
        isNull(vaultSecrets.deletedAt),
      ),
    )
    .orderBy(desc(vaultSecrets.createdAt))
    .limit(1);
  const accountId = mandate?.serviceSecretId ?? null;
  const fullNameToken = fullName ? secretToken("FULL_NAME", fullName.id) : "{{vault:FULL_NAME}}";
  const accountToken = accountId ? secretToken("ACCOUNT_NO", accountId) : "{{vault:ACCOUNT_NO}}";
  const secretIds = [fullName?.id, accountId].filter((id): id is string => !!id);

  const facts: DisputeFacts = {
    providerName: provider?.name ?? "Unknown provider",
    alias: holder?.alias ?? "Holder",
    fullNameToken,
    accountToken,
    referenceCode: receipt?.referenceCode ?? "unknown",
    effectiveDate: receipt?.effectiveDate ?? "unknown",
    noticeDate: notice?.occurredAt.toISOString().slice(0, 10) ?? "unknown",
    noticeMessageId: notice?.externalRef ?? "unknown",
    loaRef: mandate?.loaDocumentId ?? mandate?.id ?? "unknown",
    timeline: timeline.map((row) => ({
      at: row.createdAt.toISOString().slice(0, 10),
      action: row.action,
    })),
    charge: formatCents(input.disputedChargeCents, input.currency ?? "SGD"),
  };
  // Tokenize any raw values that slipped in (provider names are public).
  const redactedCharge = await redact(conn, facts.charge, c.holderId);
  facts.charge = redactedCharge;
  return { facts, secretIds, tokens: new Map() };
}

/**
 * Generate the dispute package PDF and store it as `DISPUTE_PACKAGE`. The
 * stored copy holds vault tokens, never raw identifiers.
 */
export async function generateDisputePackage(
  input: DisputeInput,
  deps: DisputeDeps = {},
): Promise<{ documentId: string }> {
  const conn = db;
  const storage = deps.storage ?? createStorage();
  const { facts } = await collectFacts(conn, input);
  const lines = buildDisputeLines(facts);
  const bytes = await renderPdf(lines);
  const documentId = crypto.randomUUID();
  const key = documentKey(input.caseId, documentId, "pdf");
  const { sha256 } = await storage.put(key, bytes, "application/pdf");
  const fallback = createHash("sha256").update(bytes).digest("hex");
  await conn.insert(caseDocuments).values({
    id: documentId,
    caseId: input.caseId,
    kind: "DISPUTE_PACKAGE",
    storageKey: key,
    sha256: sha256 ?? fallback,
  });
  return { documentId };
}

/**
 * Render the stored dispute package with tokens resolved, for download by
 * the case owner only. The rendered copy is never stored.
 */
export async function renderDisputePackageForOwner(
  caseId: string,
  disputedChargeCents: number | null,
): Promise<Uint8Array> {
  const conn = db;
  const { facts, secretIds } = await collectFacts(conn, { caseId, disputedChargeCents });
  const values = secretIds.length > 0 ? await getSecretValues(conn, secretIds) : new Map();
  const resolved = buildDisputeLines(facts).map((line) =>
    line.replace(/\{\{vault:([A-Z_]+):([0-9a-fA-F-]{36})\}\}/g, (token, _kind, id: string) => {
      return values.get(id) ?? token;
    }),
  );
  return renderPdf(resolved);
}
