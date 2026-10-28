import { eq, sql } from "drizzle-orm";

import type { Database, Transaction } from "~/server/db";
import { creditLedger } from "~/server/db/schema";

/** Balance cache TTL: 30 seconds. */
const BALANCE_TTL_SECONDS = 30;

function balanceCacheKey(billingCustomerId: string): string {
  return `billing:balance:${billingCustomerId}`;
}

/**
 * Identity Valkey client, loaded lazily: a static barrel import here would
 * close a cases → billing → identity → cases cycle at module load.
 */
async function valkeyClient() {
  const { valkey } = await import("~/features/identity");
  return valkey();
}

/** Cache ops are best-effort and bounded: a down Valkey never stalls billing. */
const CACHE_OP_TIMEOUT_MS = 500;

/** Race `op` against a timeout. Shared by the verification once-flag. */
export async function withTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("cache timeout")), ms);
  });
  try {
    return await Promise.race([op, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Sum of `credit_ledger.delta` for the customer. No date filter: expiry is rows. */
export async function ledgerBalance(
  conn: Database | Transaction,
  billingCustomerId: string,
): Promise<number> {
  const [row] = await conn
    .select({ total: sql<number | null>`coalesce(sum(${creditLedger.delta}), 0)` })
    .from(creditLedger)
    .where(eq(creditLedger.billingCustomerId, billingCustomerId));
  return Number(row?.total ?? 0);
}

/** Cached balance for reads. Spending paths use `ledgerBalance` in a locked tx. */
export async function cachedBalance(conn: Database, billingCustomerId: string): Promise<number> {
  try {
    const client = await valkeyClient();
    const hit = await withTimeout(
      client.get(balanceCacheKey(billingCustomerId)),
      CACHE_OP_TIMEOUT_MS,
    );
    if (hit !== null) {
      const parsed = Number(hit);
      if (Number.isFinite(parsed)) return parsed;
    }
  } catch {
    // A down Valkey never blocks billing reads.
  }
  const total = await ledgerBalance(conn, billingCustomerId);
  try {
    const client = await valkeyClient();
    await withTimeout(
      client.set(balanceCacheKey(billingCustomerId), String(total), "EX", BALANCE_TTL_SECONDS),
      CACHE_OP_TIMEOUT_MS,
    );
  } catch {
    // Ignore cache write faults.
  }
  return total;
}

/** Clear the cached balance. Called on every ledger insert. */
export async function clearBalanceCache(billingCustomerId: string): Promise<void> {
  try {
    const client = await valkeyClient();
    await withTimeout(client.del(balanceCacheKey(billingCustomerId)), CACHE_OP_TIMEOUT_MS);
  } catch {
    // Ignore cache faults.
  }
}
