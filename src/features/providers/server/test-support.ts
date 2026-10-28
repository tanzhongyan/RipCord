import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { createCaller } from "~/server/api/root";
import { type Database, db } from "~/server/db";
import * as schema from "~/server/db/schema";
import { providerChannels, providers, users } from "~/server/db/schema";
import { env } from "~/shared/config/env";
import type { ProviderValkey } from "./valkey";

/** In-memory Valkey double. TTLs are recorded, never enforced. */
export class FakeValkey implements ProviderValkey {
  readonly strings = new Map<string, { value: string; ttl: number | null }>();
  readonly sets = new Map<string, Set<string>>();
  readonly lists = new Map<string, string[]>();

  async get(key: string): Promise<string | null> {
    return this.strings.get(key)?.value ?? null;
  }

  async set(key: string, value: string, _mode: "EX", seconds: number): Promise<unknown> {
    this.strings.set(key, { value, ttl: seconds });
    return "OK";
  }

  async del(...keys: string[]): Promise<unknown> {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) removed += 1;
      if (this.sets.delete(key)) removed += 1;
      if (this.lists.delete(key)) removed += 1;
    }
    return removed;
  }

  async incr(key: string): Promise<number> {
    const current = Number(this.strings.get(key)?.value ?? 0) + 1;
    this.strings.set(key, { value: String(current), ttl: this.strings.get(key)?.ttl ?? null });
    return current;
  }

  async expire(key: string, seconds: number): Promise<unknown> {
    const entry = this.strings.get(key);
    if (entry) entry.ttl = seconds;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    return this.strings.get(key)?.ttl ?? -1;
  }

  async sadd(key: string, ...members: string[]): Promise<unknown> {
    let set = this.sets.get(key);
    if (!set) {
      set = new Set();
      this.sets.set(key, set);
    }
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member);
        added += 1;
      }
    }
    return added;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async lpush(key: string, ...elements: string[]): Promise<unknown> {
    let list = this.lists.get(key);
    if (!list) {
      list = [];
      this.lists.set(key, list);
    }
    for (const element of elements) list.unshift(element);
    return list.length;
  }

  async ltrim(key: string, start: number, stop: number): Promise<unknown> {
    const list = this.lists.get(key) ?? [];
    this.lists.set(key, sliceRange(list, start, stop));
    return "OK";
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return sliceRange(this.lists.get(key) ?? [], start, stop);
  }
}

function sliceRange(list: string[], start: number, stop: number): string[] {
  const end = stop < 0 ? list.length + stop + 1 : stop + 1;
  return list.slice(start, end);
}

export function callerFor(userId: string | null, orgIds: string[]) {
  return createCaller({
    db,
    userId,
    orgIds,
    ownerId: userId,
    headers: new Headers(),
  });
}

/**
 * A drizzle client over its own connection that records every SQL statement
 * the code under test runs. The driver's one-off `pg_catalog` type lookup
 * on a fresh connection is skipped: it is not our query.
 */
export function createCountingDb(): {
  db: Database;
  queries: string[];
  close: () => Promise<void>;
} {
  const queries: string[] = [];
  const conn = postgres(env.DATABASE_URL, {
    debug: (connection, query) => {
      if (query.includes("pg_catalog")) return;
      queries.push(`${connection}:${query}`);
    },
  });
  return { db: drizzle(conn, { schema }), queries, close: () => conn.end() };
}

export async function seedUser(input: { email?: string; role?: string | null } = {}) {
  const [row] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      name: "Test User",
      email: input.email ?? `${randomUUID()}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      role: input.role ?? null,
    })
    .returning();
  if (!row) throw new Error("seedUser failed");
  return row;
}

export async function seedProvider(input: { slug?: string; name?: string } = {}) {
  const [row] = await db
    .insert(providers)
    .values({
      name: input.name ?? "Test Provider",
      slug: input.slug ?? `provider-${randomUUID()}`,
      country: "SG",
      category: "MOBILE_POSTPAID",
      website: "https://provider.example.com",
    })
    .returning();
  if (!row) throw new Error("seedProvider failed");
  return row;
}

export async function seedChannel(
  providerId: string,
  overrides: Partial<typeof providerChannels.$inferInsert> = {},
) {
  const [row] = await db
    .insert(providerChannels)
    .values({
      providerId,
      serviceType: "MOBILE_POSTPAID",
      kind: "EMAIL",
      address: `cancel-${randomUUID()}@provider.test`,
      acceptsLoa: "YES",
      requiredDocuments: [],
      requiredSecrets: ["FULL_NAME", "NRIC", "ACCOUNT_NO"],
      isVerifiedDestination: true,
      sourceUrl: "https://provider.example.com/cancel",
      checkedAt: new Date(),
      confidence: 90,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("seedChannel failed");
  return row;
}
