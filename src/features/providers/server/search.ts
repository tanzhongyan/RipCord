import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { db } from "~/server/db";
import { providerChannels, providerPolicies, providers } from "~/server/db/schema";
import type { SearchProvidersInput } from "../index";
import { type ProviderValkey, valkey } from "./valkey";

export const SEARCH_CACHE_TTL_SECONDS = 600;
export const SEARCH_RATE_LIMIT_PER_MINUTE = 60;
export const SEARCH_SIMILARITY_THRESHOLD = 0.3;
export const SEARCH_MAX_RESULTS = 5;

export interface ProviderSearchDeps {
  db: Database;
  valkey: ProviderValkey;
}

export function liveSearchDeps(): ProviderSearchDeps {
  return { db, valkey: valkey() };
}

export interface ProviderSearchHit {
  id: string;
  slug: string;
  name: string;
  category: string;
  score: number;
}

function searchCacheKey(query: string, country: string | undefined): string {
  const normalized = query.trim().toLowerCase();
  return country ? `providers:search:${normalized}:${country}` : `providers:search:${normalized}`;
}

function searchIndexKey(providerId: string): string {
  return `providers:search:idx:${providerId}`;
}

function searchRateLimitKey(ip: string): string {
  return `providers:search:rl:${ip}`;
}

/**
 * Clear every cached search that returned this provider. Each cache write
 * records its key in a per-provider set, so a write drops exactly the keys
 * that could mention the provider.
 */
export async function invalidateProviderSearchCache(
  cache: ProviderValkey,
  providerId: string,
): Promise<void> {
  const indexKey = searchIndexKey(providerId);
  const keys = await cache.smembers(indexKey);
  if (keys.length > 0) await cache.del(...keys);
  await cache.del(indexKey);
}

/**
 * Fuzzy provider lookup over `pg_trgm` similarity on name and slug. Public
 * data, so no login is needed; abuse is capped per IP in Valkey. Hits are
 * cached for 10 minutes keyed on the lower-cased query.
 */
export async function searchProviders(
  input: SearchProvidersInput,
  caller: { ip: string },
  deps: ProviderSearchDeps,
): Promise<ProviderSearchHit[]> {
  const rateKey = searchRateLimitKey(caller.ip);
  const calls = await deps.valkey.incr(rateKey);
  if (calls === 1) await deps.valkey.expire(rateKey, 60);
  if (calls > SEARCH_RATE_LIMIT_PER_MINUTE) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "[RATE_LIMITED] Provider search allows 60 requests per minute",
    });
  }

  const cacheKey = searchCacheKey(input.query, input.country);
  const cached = await deps.valkey.get(cacheKey);
  if (cached) return JSON.parse(cached) as ProviderSearchHit[];

  const query = input.query.trim();
  const score = sql<number>`greatest(similarity(${providers.name}, ${query}), similarity(${providers.slug}, ${query}))`;
  const filters = [sql`${score} >= ${SEARCH_SIMILARITY_THRESHOLD}`];
  if (input.country) filters.push(eq(providers.country, input.country));
  const rows = await deps.db
    .select({
      id: providers.id,
      slug: providers.slug,
      name: providers.name,
      category: providers.category,
      score,
    })
    .from(providers)
    .where(and(...filters))
    .orderBy(desc(score))
    .limit(SEARCH_MAX_RESULTS);

  const hits = rows.map((row) => ({ ...row, score: Number(row.score) }));
  await deps.valkey.set(cacheKey, JSON.stringify(hits), "EX", SEARCH_CACHE_TTL_SECONDS);
  for (const hit of hits) {
    const indexKey = searchIndexKey(hit.id);
    await deps.valkey.sadd(indexKey, cacheKey);
    await deps.valkey.expire(indexKey, SEARCH_CACHE_TTL_SECONDS);
  }
  return hits;
}

export interface ProviderDetailChannel {
  id: string;
  serviceType: string | null;
  kind: string;
  address: string;
  ivrPath: unknown;
  hours: unknown;
  acceptsLoa: string;
  requiredDocuments: unknown;
  requiredSecrets: unknown;
  noticeDays: number | null;
  verified: boolean;
  sourceUrl: string;
  sourceQuote: string | null;
  checkedAt: Date;
  confidence: number;
}

export interface ProviderDetailPolicy {
  id: string;
  serviceType: string | null;
  kind: string;
  rule: unknown;
  excerpt: string;
  sourceUrl: string;
  checkedAt: Date;
}

export interface ProviderDetail {
  id: string;
  slug: string;
  name: string;
  country: string;
  category: string;
  website: string;
  channels: ProviderDetailChannel[];
  policies: ProviderDetailPolicy[];
}

/** One provider id for a slug, or `NOT_FOUND`. The MCP resource reads by slug. */
export async function getProviderBySlug(
  input: { slug: string },
  deps: ProviderSearchDeps,
): Promise<ProviderDetail> {
  const rows = await deps.db
    .select({ id: providers.id })
    .from(providers)
    .where(eq(providers.slug, input.slug))
    .limit(1);
  const hit = rows[0];
  if (!hit) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Provider not found" });
  }
  return getProvider({ id: hit.id }, deps);
}

/**
 * One provider with its channels and policies in a single query. Unverified
 * channels are included with `verified: false`; callers must not send PII
 * to them (the vault release rules enforce this).
 */
export async function getProvider(
  input: { id: string },
  deps: ProviderSearchDeps,
): Promise<ProviderDetail> {
  const rows = await deps.db
    .select({
      provider: providers,
      channel: providerChannels,
      policy: providerPolicies,
    })
    .from(providers)
    .leftJoin(providerChannels, eq(providerChannels.providerId, providers.id))
    .leftJoin(providerPolicies, eq(providerPolicies.providerId, providers.id))
    .where(eq(providers.id, input.id));

  const first = rows[0];
  if (!first) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Provider not found" });
  }

  const channels = new Map<string, ProviderDetailChannel>();
  const policies = new Map<string, ProviderDetailPolicy>();
  for (const row of rows) {
    if (row.channel && !channels.has(row.channel.id)) {
      channels.set(row.channel.id, {
        id: row.channel.id,
        serviceType: row.channel.serviceType,
        kind: row.channel.kind,
        address: row.channel.address,
        ivrPath: row.channel.ivrPath,
        hours: row.channel.hours,
        acceptsLoa: row.channel.acceptsLoa,
        requiredDocuments: row.channel.requiredDocuments,
        requiredSecrets: row.channel.requiredSecrets,
        noticeDays: row.channel.noticeDays,
        verified: row.channel.isVerifiedDestination,
        sourceUrl: row.channel.sourceUrl,
        sourceQuote: row.channel.sourceQuote,
        checkedAt: row.channel.checkedAt,
        confidence: row.channel.confidence,
      });
    }
    if (row.policy && !policies.has(row.policy.id)) {
      policies.set(row.policy.id, {
        id: row.policy.id,
        serviceType: row.policy.serviceType,
        kind: row.policy.kind,
        rule: row.policy.rule,
        excerpt: row.policy.excerpt,
        sourceUrl: row.policy.sourceUrl,
        checkedAt: row.policy.checkedAt,
      });
    }
  }

  return {
    id: first.provider.id,
    slug: first.provider.slug,
    name: first.provider.name,
    country: first.provider.country,
    category: first.provider.category,
    website: first.provider.website,
    channels: [...channels.values()],
    policies: [...policies.values()],
  };
}
