import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { providerChannels, providerPolicies } from "~/server/db/schema";
import type { ModelExtraction } from "./model";

export interface UpsertSummary {
  added: string[];
  changed: string[];
  removed: string[];
}

function serviceTypeMatch(
  column: typeof providerChannels.serviceType,
  value: typeof providerChannels.$inferSelect.serviceType,
) {
  return value === null ? isNull(column) : eq(column, value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function droppedEntries(oldList: string[], newList: string[]): boolean {
  return oldList.some((entry) => !newList.includes(entry));
}

function ruleKeys(rule: unknown): string[] {
  if (typeof rule !== "object" || rule === null || Array.isArray(rule)) return [];
  return Object.keys(rule);
}

/**
 * Upsert one page's extraction. Channels key on
 * `(provider_id, service_type, kind, address)`; policies on
 * `(provider_id, service_type, kind)`. New rows start unverified, and an
 * update never touches `is_verified_destination`: only an admin flips that.
 * Each channel keeps the quote it came from, and dropped list entries or
 * nulled fields are reported as removed for a human to review.
 */
export async function upsertExtraction(
  conn: Database,
  providerId: string,
  pageUrl: string,
  extraction: ModelExtraction,
  checkedAt: Date,
): Promise<UpsertSummary> {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const channel of extraction.channels) {
    const [existing] = await conn
      .select()
      .from(providerChannels)
      .where(
        and(
          eq(providerChannels.providerId, providerId),
          serviceTypeMatch(providerChannels.serviceType, channel.serviceType),
          eq(providerChannels.kind, channel.kind),
          eq(providerChannels.address, channel.address),
        ),
      )
      .limit(1);
    if (!existing) {
      await conn.insert(providerChannels).values({
        providerId,
        serviceType: channel.serviceType,
        kind: channel.kind,
        address: channel.address,
        ivrPath: channel.ivrPath,
        hours: channel.hours,
        acceptsLoa: channel.acceptsLoa,
        requiredDocuments: channel.requiredDocuments,
        requiredSecrets: channel.requiredSecrets,
        noticeDays: channel.noticeDays,
        isVerifiedDestination: false,
        sourceUrl: pageUrl,
        sourceQuote: channel.quote,
        checkedAt,
        confidence: channel.confidence,
      });
      added.push(`channel:${channel.address}`);
      continue;
    }
    const differs =
      !sameJson(existing.ivrPath, channel.ivrPath) ||
      !sameJson(existing.hours, channel.hours) ||
      existing.acceptsLoa !== channel.acceptsLoa ||
      !sameJson(existing.requiredDocuments, channel.requiredDocuments) ||
      !sameJson(existing.requiredSecrets, channel.requiredSecrets) ||
      existing.noticeDays !== channel.noticeDays ||
      existing.sourceUrl !== pageUrl ||
      existing.sourceQuote !== channel.quote ||
      existing.confidence !== channel.confidence;
    // A partial crawl cannot prove a row is gone, so rows are never deleted;
    // dropped list entries and nulled fields are reported for a human instead.
    if (droppedEntries(asStringList(existing.requiredDocuments), channel.requiredDocuments)) {
      removed.push(`channel:${channel.address}:requiredDocuments`);
    }
    if (droppedEntries(asStringList(existing.requiredSecrets), channel.requiredSecrets)) {
      removed.push(`channel:${channel.address}:requiredSecrets`);
    }
    if (existing.ivrPath !== null && channel.ivrPath === null) {
      removed.push(`channel:${channel.address}:ivrPath`);
    }
    if (existing.hours !== null && channel.hours === null) {
      removed.push(`channel:${channel.address}:hours`);
    }
    if (existing.noticeDays !== null && channel.noticeDays === null) {
      removed.push(`channel:${channel.address}:noticeDays`);
    }
    if (differs) {
      await conn
        .update(providerChannels)
        .set({
          ivrPath: channel.ivrPath,
          hours: channel.hours,
          acceptsLoa: channel.acceptsLoa,
          requiredDocuments: channel.requiredDocuments,
          requiredSecrets: channel.requiredSecrets,
          noticeDays: channel.noticeDays,
          sourceUrl: pageUrl,
          sourceQuote: channel.quote,
          checkedAt,
          confidence: channel.confidence,
        })
        .where(eq(providerChannels.id, existing.id));
      changed.push(`channel:${channel.address}`);
    }
  }

  for (const policy of extraction.policies) {
    const [existing] = await conn
      .select()
      .from(providerPolicies)
      .where(
        and(
          eq(providerPolicies.providerId, providerId),
          policy.serviceType === null
            ? isNull(providerPolicies.serviceType)
            : eq(providerPolicies.serviceType, policy.serviceType),
          eq(providerPolicies.kind, policy.kind),
        ),
      )
      .limit(1);
    if (!existing) {
      await conn.insert(providerPolicies).values({
        providerId,
        serviceType: policy.serviceType,
        kind: policy.kind,
        rule: policy.rule,
        excerpt: policy.excerpt,
        sourceUrl: pageUrl,
        checkedAt,
      });
      added.push(`policy:${policy.kind}`);
      continue;
    }
    const differs =
      !sameJson(existing.rule, policy.rule) ||
      existing.excerpt !== policy.excerpt ||
      existing.sourceUrl !== pageUrl;
    if (droppedEntries(ruleKeys(existing.rule), ruleKeys(policy.rule))) {
      removed.push(`policy:${policy.kind}:rule`);
    }
    if (differs) {
      await conn
        .update(providerPolicies)
        .set({ rule: policy.rule, excerpt: policy.excerpt, sourceUrl: pageUrl, checkedAt })
        .where(eq(providerPolicies.id, existing.id));
      changed.push(`policy:${policy.kind}`);
    }
  }

  return { added, changed, removed };
}
