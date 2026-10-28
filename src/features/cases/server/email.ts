import { deflateSync, inflateSync } from "node:zlib";

import { and, desc, eq, isNull } from "drizzle-orm";
import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from "pdf-lib";

import { resolveDelegateName } from "~/features/identity";
import { db } from "~/server/db";
import {
  caseDocuments,
  type cases,
  communications,
  contractTerms,
  type mandates,
  type providerChannels,
  providers,
  users,
  vaultSecrets,
} from "~/server/db/schema";
import { createStorage, type StorageClient } from "~/server/storage";
import { getSecretValue, resolveTokens, secretToken } from "~/server/vault";
import { env } from "~/shared/config/env";
import { ToolError } from "./errors";
import { sendMail } from "./mailer";
import { loadNoticeEmailTemplate } from "./prompts";
import { isLiveCase } from "./sandbox";

type CaseRow = typeof cases.$inferSelect;
type ChannelRow = typeof providerChannels.$inferSelect;
type MandateRow = typeof mandates.$inferSelect;
type StepRow = {
  id: string;
  args: unknown;
  approvedAt: Date | null;
};

export interface EmailStepDeps {
  storage?: StorageClient;
  now?: () => Date;
  /** Retry delays for the SMTP send. Tests pass zeros. */
  delaysMs?: number[];
}

/** Human labels for the contract's `service_type` values. */
const SERVICE_LABELS: Record<string, string> = {
  MOBILE_POSTPAID: "Mobile postpaid",
  MOBILE_PREPAID: "Mobile prepaid",
  BROADBAND: "Broadband",
  PAY_TV: "Pay TV",
  FIXED_LINE: "Fixed line",
  UTILITY: "Utility",
  GYM: "Gym",
  STREAMING: "Streaming",
  SAAS: "SaaS",
  OTHER: "Other",
};

function serviceLabel(serviceType: string | null): string {
  return (serviceType && SERVICE_LABELS[serviceType]) || "Service";
}

function stepArg(args: unknown, key: string): unknown {
  if (typeof args !== "object" || args === null) return undefined;
  return (args as Record<string, unknown>)[key];
}

function recommendationUntil(recommendation: unknown): string | null {
  if (typeof recommendation !== "object" || recommendation === null) return null;
  const record = recommendation as Record<string, unknown>;
  if (record.action !== "WAIT_UNTIL" || typeof record.until !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(record.until) ? record.until : null;
}

function shiftDate(today: Date, days: number): string {
  const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The newest live secret of a kind, or null. Holders can hold several
 * `ACCOUNT_NO` secrets; the mandate's service secret picks the account,
 * but names and emails take the newest.
 */
async function newestSecretId(
  holderId: string,
  kind: "FULL_NAME" | "EMAIL",
): Promise<string | null> {
  const [row] = await db
    .select({ id: vaultSecrets.id })
    .from(vaultSecrets)
    .where(
      and(
        eq(vaultSecrets.holderId, holderId),
        eq(vaultSecrets.kind, kind),
        isNull(vaultSecrets.deletedAt),
      ),
    )
    .orderBy(desc(vaultSecrets.createdAt))
    .limit(1);
  return row?.id ?? null;
}

async function holderEmailAddress(holderId: string): Promise<string | null> {
  const id = await newestSecretId(holderId, "EMAIL");
  if (!id) return null;
  try {
    return await getSecretValue(db, id);
  } catch {
    return null;
  }
}

/**
 * Swap the template's short tokens (`{{vault:FULL_NAME}}`) for full tokens
 * (`{{vault:FULL_NAME:<id>}}`) naming the holder's secrets. The account is
 * the mandate's service secret: the account being cancelled.
 */
async function expandShortTokens(
  text: string,
  holderId: string,
  serviceSecretId: string,
): Promise<string> {
  const fullNameId = await newestSecretId(holderId, "FULL_NAME");
  if (!fullNameId) {
    throw new ToolError("VALIDATION", "The holder's name is missing from the vault");
  }
  return text
    .replaceAll("{{vault:FULL_NAME}}", secretToken("FULL_NAME", fullNameId))
    .replaceAll("{{vault:ACCOUNT_NO}}", secretToken("ACCOUNT_NO", serviceSecretId));
}

async function loadLoaBytes(storageKey: string, storage: StorageClient): Promise<Uint8Array> {
  if (storageKey.startsWith("data:")) {
    const payload = storageKey.split(",")[1] ?? "";
    return new Uint8Array(Buffer.from(payload, "base64"));
  }
  return storage.get(storageKey);
}

const FULL_TOKEN_RE = /\{\{vault:([A-Z_]+):([0-9a-fA-F-]{36})\}\}/g;

function hexToText(hex: string): string {
  const compact = hex.replace(/\s+/g, "");
  const padded = compact.length % 2 === 0 ? compact : `${compact}0`;
  return Buffer.from(padded, "hex").toString("latin1");
}

function textToHex(text: string): string {
  return Buffer.from(text, "latin1").toString("hex").toUpperCase();
}

function unescapePdfLiteral(literal: string): string {
  return literal.replace(/\\([nrtbf()\\])/g, (_match, char: string) => {
    switch (char) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      default:
        return char;
    }
  });
}

function replaceTokens(text: string, values: Map<string, string>): string {
  return text.replace(FULL_TOKEN_RE, (token) => values.get(token) ?? token);
}

/**
 * Rewrite one decoded content stream: vault tokens inside hex and literal
 * text strings resolve to real values, re-encoded as hex. Values outside
 * latin-1 degrade to their low bytes; fixtures stay ASCII.
 */
function resolveStreamTokens(stream: string, values: Map<string, string>): string {
  const withHex = stream.replace(/<([0-9A-Fa-f\s]+)>(\s*Tj)/g, (match, hex: string, op: string) => {
    const text = hexToText(hex);
    const resolved = replaceTokens(text, values);
    return resolved === text ? match : `<${textToHex(resolved)}>${op}`;
  });
  return withHex.replace(/\(((?:[^()\\]|\\.)*)\)(\s*Tj)/g, (match, literal: string, op: string) => {
    const text = unescapePdfLiteral(literal);
    const resolved = replaceTokens(text, values);
    return resolved === text ? match : `<${textToHex(resolved)}>${op}`;
  });
}

/** Every full vault token named in the letter's decoded text streams. */
async function collectLoaTokens(pdf: Uint8Array): Promise<Set<string>> {
  const tokens = new Set<string>();
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  for (const page of doc.getPages()) {
    const contents = page.node.get(PDFName.of("Contents"));
    const refs: PDFRef[] =
      contents instanceof PDFRef
        ? [contents]
        : contents instanceof PDFArray
          ? contents.asArray().filter((entry): entry is PDFRef => entry instanceof PDFRef)
          : [];
    for (const ref of refs) {
      const stream = doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      if (!stream.dict.get(PDFName.of("Filter"))?.toString().includes("FlateDecode")) continue;
      const inflated = inflateSync(stream.getContents()).toString("latin1");
      for (const match of inflated.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
        for (const token of hexToText(match[1] ?? "").matchAll(FULL_TOKEN_RE)) {
          tokens.add(token[0]);
        }
      }
      for (const match of inflated.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) {
        for (const token of unescapePdfLiteral(match[1] ?? "").matchAll(FULL_TOKEN_RE)) {
          tokens.add(token[0]);
        }
      }
    }
  }
  return tokens;
}

/**
 * Resolve the LOA's vault tokens to real values. Each Flate-encoded content
 * stream is inflated, its text strings rewritten, and deflated again, then
 * pdf-lib re-saves the file with a fresh cross-reference table. The stored
 * letter keeps tokens; only the attached copy holds values.
 */
async function resolveLoaTokens(pdf: Uint8Array, values: Map<string, string>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  let changed = false;
  for (const page of doc.getPages()) {
    const contents = page.node.get(PDFName.of("Contents"));
    const refs: PDFRef[] =
      contents instanceof PDFRef
        ? [contents]
        : contents instanceof PDFArray
          ? contents.asArray().filter((entry): entry is PDFRef => entry instanceof PDFRef)
          : [];
    for (const ref of refs) {
      const stream = doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      if (!stream.dict.get(PDFName.of("Filter"))?.toString().includes("FlateDecode")) continue;
      const inflated = inflateSync(stream.getContents()).toString("latin1");
      const resolved = resolveStreamTokens(inflated, values);
      if (resolved === inflated) continue;
      changed = true;
      const deflated = deflateSync(resolved);
      const next = PDFRawStream.of(stream.dict, deflated);
      next.dict.set(PDFName.of("Length"), PDFNumber.of(deflated.length));
      doc.context.assign(ref, next);
    }
  }
  if (!changed) return pdf;
  return doc.save();
}

/**
 * `send-notice-email`: the written termination notice with the signed LOA
 * attached. Tokens resolve inside the send call only; the stored
 * `communications` row keeps tokens. Sandbox mail goes to Mailpit, and the
 * vault's sandbox rule blocks non-`.test` destinations before anything is
 * sent. Returns the stored subject line (tokenized) and the `Message-ID`.
 */
export async function runEmailStep(
  c: CaseRow,
  step: StepRow,
  channel: ChannelRow,
  mandate: MandateRow,
  deps: EmailStepDeps = {},
): Promise<{ subject: string; messageId: string }> {
  const now = (deps.now ?? (() => new Date()))();
  const storage = deps.storage ?? createStorage();
  const [provider] = await db
    .select({ name: providers.name })
    .from(providers)
    .where(eq(providers.id, channel.providerId))
    .limit(1);
  const [terms] = await db
    .select({ noticeDays: contractTerms.noticeDays })
    .from(contractTerms)
    .where(eq(contractTerms.caseId, c.id))
    .limit(1);

  const until = recommendationUntil(c.recommendation);
  const noticeDays = terms?.noticeDays ?? channel.noticeDays ?? 0;
  const requestedDate = until ?? shiftDate(now, noticeDays);

  const customBody = stepArg(step.args, "replyBody");
  const template = loadNoticeEmailTemplate();
  const rawBody =
    typeof customBody === "string" && customBody
      ? customBody
      : template
          .replaceAll("{provider.name}", provider?.name ?? "Unknown provider")
          .replaceAll("{service_label}", serviceLabel(c.serviceType))
          .replaceAll("{requested_date}", requestedDate)
          .replaceAll(
            "{delegate_display_name}",
            await resolveDelegateName(db, mandate.delegateUserId, mandate.delegateOrgId),
          )
          .replaceAll("{mandate_id}", mandate.id);
  const subjectTemplate = "Termination request – account {{vault:ACCOUNT_NO}}";
  const subject = await expandShortTokens(subjectTemplate, c.holderId, mandate.serviceSecretId);
  const body = await expandShortTokens(rawBody, c.holderId, mandate.serviceSecretId);

  const releaseCtx = {
    caseId: c.id,
    stepId: step.id,
    mandateId: mandate.id,
    providerChannelId: channel.id,
  };
  // One call resolves both lines, so each secret releases once even when it
  // appears in the subject and the body. The sandbox rule denies here,
  // before any byte reaches the network.
  const resolved = await resolveTokens(db, `${subject}\n${body}`, releaseCtx);
  const newline = resolved.indexOf("\n");
  const resolvedSubject = resolved.slice(0, newline);
  const resolvedBody = resolved.slice(newline + 1);

  const [loa] = await db
    .select({ storageKey: caseDocuments.storageKey })
    .from(caseDocuments)
    .where(eq(caseDocuments.id, mandate.loaDocumentId ?? ""))
    .limit(1);
  if (!loa) throw new ToolError("VALIDATION", "The signed authorisation letter is missing");
  const loaBytes = await loadLoaBytes(loa.storageKey, storage);
  const loaValues = new Map<string, string>();
  for (const token of await collectLoaTokens(loaBytes)) {
    loaValues.set(token, await resolveTokens(db, token, releaseCtx));
  }
  const resolvedLoa = await resolveLoaTokens(loaBytes, loaValues);

  const holderEmail = await holderEmailAddress(c.holderId);
  const [owner] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, c.ownerUserId))
    .limit(1);
  const live = isLiveCase(c, mandate);
  const { messageId } = await sendMail(
    {
      from: env.MAIL_FROM,
      to: channel.address,
      ...(holderEmail ? { cc: holderEmail } : {}),
      replyTo: holderEmail ?? owner?.email ?? env.MAIL_FROM,
      subject: resolvedSubject,
      text: resolvedBody,
      attachments: [
        {
          filename: "letter-of-authorisation.pdf",
          content: resolvedLoa,
          contentType: "application/pdf",
        },
      ],
    },
    { sandbox: !live, delaysMs: deps.delaysMs },
  );

  await db.insert(communications).values({
    caseId: c.id,
    stepId: step.id,
    channel: "EMAIL",
    direction: "OUTBOUND",
    body: `${subject}\n${body}`,
    externalRef: messageId,
    occurredAt: now,
  });
  return { subject, messageId };
}
