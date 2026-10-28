import { and, eq, isNull, lte } from "drizzle-orm";

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
  const rows = await conn
    .select({
      caseId: verifications.caseId,
      dueAt: verifications.dueAt,
      result: verifications.result,
    })
    .from(verifications)
    .where(and(lte(verifications.dueAt, now), isNull(verifications.result)));
  let emailed = 0;
  let silentSucceeded = 0;
  for (const row of rows) {
    if (now.getTime() >= row.dueAt.getTime() + 30 * DAY_MS) {
      await conn
        .update(verifications)
        .set({ result: "UNKNOWN", resolvedAt: now })
        .where(eq(verifications.caseId, row.caseId));
      try {
        await transition(row.caseId, "SUCCEEDED", {
          actor: { type: "SYSTEM", id: "verifications-cron" },
          now: () => now,
        });
      } catch {
        // The case may already be terminal; the UNKNOWN mark stands.
      }
      silentSucceeded += 1;
      continue;
    }
    const flag = await safeGet(verificationEmailedKey(row.caseId));
    if (flag) continue;
    const sent = await emailOwnerOnce(conn, row.caseId, row.dueAt, now);
    if (sent) {
      await safeSet(verificationEmailedKey(row.caseId), now.toISOString());
      emailed += 1;
    }
  }
  return { emailed, silentSucceeded, checked: rows.length };
}

/** Identity Valkey client, loaded lazily to avoid a load-time cycle. */
async function valkeyClient() {
  const { valkey } = await import("~/features/identity");
  return valkey();
}

/** Once-flag ops are best-effort and bounded: a down Valkey never stalls the cron. */
const FLAG_OP_TIMEOUT_MS = 500;

async function safeGet(key: string): Promise<string | null> {
  try {
    const client = await valkeyClient();
    return await withTimeout(client.get(key), FLAG_OP_TIMEOUT_MS);
  } catch {
    return null;
  }
}

async function safeSet(key: string, value: string): Promise<void> {
  try {
    const client = await valkeyClient();
    await withTimeout(client.set(key, value, "EX", (60 * DAY_MS) / 1000), FLAG_OP_TIMEOUT_MS);
  } catch {
    // A down Valkey means a possible resend; the job still succeeds.
  }
}

async function emailOwnerOnce(
  conn: Database,
  caseId: string,
  _dueAt: Date,
  _now: Date,
): Promise<boolean> {
  const [c] = await conn.select().from(cases).where(eq(cases.id, caseId)).limit(1);
  if (!c) return false;
  const [holder] = await conn
    .select({ alias: accountHolders.alias })
    .from(accountHolders)
    .where(eq(accountHolders.id, c.holderId))
    .limit(1);
  const [provider] = c.providerId
    ? await conn
        .select({ name: providers.name })
        .from(providers)
        .where(eq(providers.id, c.providerId))
        .limit(1)
    : [];
  const [receipt] = await conn
    .select({ effectiveDate: receipts.effectiveDate })
    .from(receipts)
    .where(eq(receipts.caseId, caseId))
    .limit(1);
  const [owner] = await conn
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, c.ownerUserId))
    .limit(1);
  if (!owner) return false;
  const providerName = provider?.name ?? "your provider";
  const alias = holder?.alias ?? "the holder";
  const effective = receipt?.effectiveDate ?? "the effective date";
  const url = `${env.APP_URL}/cases/${caseId}`;
  await sendMail(
    {
      from: env.MAIL_FROM,
      to: owner.email,
      subject: `Did ${providerName} bill again?`,
      text:
        `Did ${providerName} bill ${alias} again after ${effective}? ` +
        `Upload the latest bill or tell us.\n\nReview the case: ${url}`,
      attachments: [],
    },
    { sandbox: false },
  );
  return true;
}
