import { and, eq } from "drizzle-orm";
import { extractText } from "unpdf";

import { db } from "~/server/db";
import { caseDocuments, receipts } from "~/server/db/schema";
import { createStorage, type StorageClient } from "~/server/storage";

export type BillProposal = "NO_REBILL" | "REBILLED";

function decodeDataUrl(storageKey: string): Uint8Array | null {
  if (!storageKey.startsWith("data:")) return null;
  const payload = storageKey.split(",")[1] ?? "";
  return new Uint8Array(Buffer.from(payload, "base64"));
}

function findDates(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    out.push(match[0]);
  }
  for (const match of text.matchAll(/\b(\d{1,2})[/](\d{1,2})[/](\d{4})\b/g)) {
    const [, d, m, y] = match;
    out.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return out;
}

/**
 * Propose the bill-check result from an uploaded bill: any charge date after
 * `effective_date` proposes `REBILLED`, else `NO_REBILL`. The user still
 * confirms via `report-bill-check`.
 */
export async function proposeBillCheck(
  caseId: string,
  documentId: string,
  storage?: StorageClient,
): Promise<{ proposal: BillProposal; dates: string[] }> {
  const [receipt] = await db
    .select({ effectiveDate: receipts.effectiveDate })
    .from(receipts)
    .where(eq(receipts.caseId, caseId))
    .limit(1);
  const [doc] = await db
    .select()
    .from(caseDocuments)
    .where(and(eq(caseDocuments.caseId, caseId), eq(caseDocuments.id, documentId)))
    .limit(1);
  if (!doc) throw new Error("Document not found");
  const store = storage ?? createStorage();
  const bytes = decodeDataUrl(doc.storageKey) ?? (await store.get(doc.storageKey));
  let text = "";
  try {
    const { text: pages } = await extractText(bytes.slice(), { mergePages: false });
    text = pages.join("\n");
  } catch {
    text = Buffer.from(bytes).toString("utf8");
  }
  const dates = findDates(text);
  const effective = receipt?.effectiveDate ?? "9999-12-31";
  const rebilled = dates.some((date) => date > effective);
  return { proposal: rebilled ? "REBILLED" : "NO_REBILL", dates };
}
