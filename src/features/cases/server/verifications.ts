import { and, eq, inArray, isNull, lte } from "drizzle-orm";

import { withTimeout } from "~/features/billing";
import { type Database, db } from "~/server/db";
import {
  accountHolders,
  cases,
  providers,
  receipts,
  users,
  verifications,
} from "~/server/db/schema";
import { env } from "~/shared/config/env";
import { transition } from "./engine";
import { ToolError } from "./errors";
import { sendMail } from "./mailer";

const DAY_MS = 86_400_000;

/** Valkey once-flag per verification: no second email. */
function verificationEmailedKey(caseId: string): string {
  return `verification:emailed:${caseId}`;
}

export interface VerificationCronCounts {
  emailed: number;
  silentSucceeded: number;
  checked: number;
}

export interface VerificationCronDeps {
  db?: Database;
  now?: () => Date;
  transitionFn?: typeof transition;
}

interface EmailFacts {
  ownerEmail: string;
  providerName: string;
  alias: string;
  effective: string;
}

/** Batch-load the email facts for every due case: five queries, not 5N. */
async function loadEmailFacts(conn: Database, caseIds: string[]): Promise<Map<string, EmailFacts>> {
  const facts = new Map<string, EmailFacts>();
  if (caseIds.length === 0) return facts;
  const caseRows = await conn
    .select({
      id: cases.id,
      ownerUserId: cases.ownerUserId,
      holderId: cases.holderId,
      providerId: cases.providerId,
    })
    .from(cases)
    .where(inArray(cases.id, caseIds));
  const holderIds = [...new Set(caseRows.map((row) => row.holderId))];
  const providerIds = [
    ...new Set(caseRows.map((row) => row.providerId).filter((id) => id !== null)),
  ];
  const ownerIds = [...new Set(caseRows.map((row) => row.ownerUserId))];
  const [holderRows, providerRows, receiptRows, ownerRows] = await Promise.all([
    holderIds.length > 0
      ? conn
          .select({ id: accountHolders.id, alias: accountHolders.alias })
          .from(accountHolders)
          .where(inArray(accountHolders.id, holderIds))
      : [],
    providerIds.length > 0
      ? conn
          .select({ id: providers.id, name: providers.name })
          .from(providers)
          .where(inArray(providers.id, providerIds))
      : [],
    conn
      .select({ caseId: receipts.caseId, effectiveDate: receipts.effectiveDate })
      .from(receipts)
      .where(inArray(receipts.caseId, caseIds)),
    ownerIds.length > 0
      ? conn
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(inArray(users.id, ownerIds))
      : [],
  ]);
  const aliases = new Map(holderRows.map((row) => [row.id, row.alias]));
  const names = new Map(providerRows.map((row) => [row.id, row.name]));
  const effectives = new Map(receiptRows.map((row) => [row.caseId, row.effectiveDate]));
  const emails = new Map(ownerRows.map((row) => [row.id, row.email]));
  for (const row of caseRows) {
    const ownerEmail = emails.get(row.ownerUserId);
    if (!ownerEmail) continue;
    facts.set(row.id, {
      ownerEmail,
      providerName: (row.providerId && names.get(row.providerId)) || "your provider",
      alias: aliases.get(row.holderId) ?? "the holder",
      effective: effectives.get(row.id) ?? "the effective date",
    });
  }
  return facts;
}

/**
 * Daily verification job. Selects rows with `due_at ≤ now() AND result IS
 * NULL` through the partial index, emails the owner once per verification,
 * and marks rows still unresolved 30 days after `due_at` as `UNKNOWN` with
 * the case moved to `SUCCEEDED`.
 */
export async function runVerificationsCron(
  deps: VerificationCronDeps = {},
): Promise<VerificationCronCounts> {
  const conn = deps.db ?? db;
  const now = (deps.now ?? (() => new Date()))();
  const moveToSucceeded = deps.transitionFn ?? transition;
  const rows = await conn
    .select({
      caseId: verifications.caseId,
      dueAt: verifications.dueAt,
      result: verifications.result,
    })
    .from(verifications)
    .where(and(lte(verifications.dueAt, now), isNull(verifications.result)));
  const facts = await loadEmailFacts(
    conn,
    rows.map((row) => row.caseId),
  );
  let emailed = 0;
  let silentSucceeded = 0;
  for (const row of rows) {
    if (now.getTime() >= row.dueAt.getTime() + 30 * DAY_MS) {
      await conn
        .update(verifications)
        .set({ result: "UNKNOWN", resolvedAt: now })
        .where(eq(verifications.caseId, row.caseId));
      try {
        await moveToSucceeded(row.caseId, "SUCCEEDED", {
          actor: { type: "SYSTEM", id: "verifications-cron" },
          now: () => now,
        });
      } catch (error) {
        // An already-terminal case keeps the UNKNOWN mark; anything else
        // (DB or network faults) must fail the cron loudly.
        if (
          !(
            error instanceof ToolError &&
            (error.code === "ILLEGAL_TRANSITION" || error.code === "NOT_FOUND")
          )
        ) {
          throw error;
        }
      }
      silentSucceeded += 1;
      continue;
    }
    const claimed = await safeClaim(verificationEmailedKey(row.caseId), now.toISOString());
    if (!claimed) continue;
    const sent = await emailOwnerOnce(facts, row.caseId);
    if (sent) emailed += 1;
  }
  return { emailed, silentSucceeded, checked: rows.length };
}

/** Identity Valkey client, prefetched dynamically to avoid a load-time cycle. */
const identityModule: Promise<typeof import("~/features/identity")> = import("~/features/identity");
identityModule.catch(() => undefined);

async function valkeyClient() {
  const { valkey } = await identityModule;
  return valkey();
}

/** Once-flag ops are best-effort and bounded: a down Valkey never stalls the cron. */
const FLAG_OP_TIMEOUT_MS = 500;

async function safeClaim(key: string, value: string): Promise<boolean> {
  try {
    const client = await valkeyClient();
    return await withTimeout(
      client.setNx(key, value, "EX", (60 * DAY_MS) / 1000),
      FLAG_OP_TIMEOUT_MS,
    );
  } catch {
    // A down Valkey means a possible resend; the job still succeeds.
    return true;
  }
}

async function emailOwnerOnce(facts: Map<string, EmailFacts>, caseId: string): Promise<boolean> {
  const entry = facts.get(caseId);
  if (!entry) return false;
  const url = `${env.APP_URL}/cases/${caseId}`;
  await sendMail(
    {
      from: env.MAIL_FROM,
      to: entry.ownerEmail,
      subject: `Did ${entry.providerName} bill again?`,
      text:
        `Did ${entry.providerName} bill ${entry.alias} again after ${entry.effective}? ` +
        `Upload the latest bill or tell us.\n\nReview the case: ${url}`,
      attachments: [],
    },
    { sandbox: false },
  );
  return true;
}
