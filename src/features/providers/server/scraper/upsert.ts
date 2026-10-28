import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { providerChannels, providerPolicies } from "~/server/db/schema";
import type { ModelExtraction } from "./model";

export interface UpsertSummary {
  added: string[];
  changed: string[];
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

/**
 * Upsert one page's extraction. Channels key on
 * `(provider_id, service_type, kind, address)`; policies on
 * `(provider_id, service_type, kind)`. New rows start unverified, and an
 * update never touches `is_verified_destination`: only an admin flips that.
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
      existing.confidence !== channel.confidence;
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
    if (differs) {
      await conn
        .update(providerPolicies)
        .set({ rule: policy.rule, excerpt: policy.excerpt, sourceUrl: pageUrl, checkedAt })
        .where(eq(providerPolicies.id, existing.id));
      changed.push(`policy:${policy.kind}`);
    }
  }

  return { added, changed };
}
