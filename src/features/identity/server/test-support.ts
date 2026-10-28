import { randomUUID } from "node:crypto";

import { createCaller } from "~/server/api/root";
import { db } from "~/server/db";
import {
  accountHolders,
  caseSteps,
  cases,
  mandates,
  members,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  organizations,
  providerChannels,
  providers,
  users,
} from "~/server/db/schema";
import type { StorageClient } from "~/server/storage";
import { storeSecret } from "~/server/vault";
import type { SmsSender } from "./sms";
import { sha256HexBytes } from "./tokens";
import type { ValkeyClient } from "./valkey";

/** In-memory Valkey double. TTLs are recorded, never enforced. */
export class FakeValkey implements ValkeyClient {
  readonly store = new Map<string, { value: string; ttl: number | null }>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }

  async set(key: string, value: string, _mode: "EX", seconds: number): Promise<unknown> {
    this.store.set(key, { value, ttl: seconds });
    return "OK";
  }

  async incr(key: string): Promise<number> {
    const current = Number(this.store.get(key)?.value ?? 0) + 1;
    this.store.set(key, { value: String(current), ttl: this.store.get(key)?.ttl ?? null });
    return current;
  }

  async expire(key: string, seconds: number): Promise<unknown> {
    const entry = this.store.get(key);
    if (entry) entry.ttl = seconds;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    return this.store.get(key)?.ttl ?? -1;
  }

  async del(key: string): Promise<unknown> {
    return this.store.delete(key) ? 1 : 0;
  }
}

export interface SmsOutbox {
  sender: SmsSender;
  messages: Array<{ to: string; body: string }>;
}

export function createSmsOutbox(): SmsOutbox {
  const messages: SmsOutbox["messages"] = [];
  return {
    messages,
    sender: (to, body) => {
      messages.push({ to, body });
      return Promise.resolve();
    },
  };
}

export function callerFor(userId: string, orgIds: string[]) {
  return createCaller({
    db,
    userId,
    orgIds,
    ownerId: userId,
    headers: new Headers(),
  });
}

/**
 * An OAuth grant for MCP tests: client, consent and one access/refresh
 * token row each. Returns the `clientId` the stub verifier maps.
 */
export async function seedOauthGrant(
  userId: string,
  name = "Test Agent",
): Promise<{ clientId: string }> {
  const clientId = `test-client-${randomUUID()}`;
  await db.insert(oauthClient).values({
    id: randomUUID(),
    clientId,
    name,
    redirectUris: ["https://agent.test/callback"],
  });
  await db.insert(oauthConsent).values({
    id: randomUUID(),
    clientId,
    userId,
    scopes: ["ripcord"],
  });
  await db.insert(oauthAccessToken).values({
    id: randomUUID(),
    token: `at-${randomUUID()}`,
    clientId,
    userId,
    scopes: ["ripcord"],
  });
  await db.insert(oauthRefreshToken).values({
    id: randomUUID(),
    token: `rt-${randomUUID()}`,
    clientId,
    userId,
    scopes: ["ripcord", "offline_access"],
  });
  return { clientId };
}

/** In-memory object-store double. */
export class FakeStorage implements StorageClient {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly deletedBatches: string[][] = [];
  readonly presigned: Array<{ key: string; contentType: string }> = [];

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<{ sha256: string }> {
    this.objects.set(key, { bytes, contentType });
    return { sha256: sha256HexBytes(bytes) };
  }

  async get(key: string): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`FakeStorage: missing key ${key}`);
    return object.bytes;
  }

  async presignUpload(key: string, contentType: string): Promise<{ url: string }> {
    this.presigned.push({ key, contentType });
    return { url: `https://storage.test/${key}?content-type=${contentType}` };
  }

  async del(keys: string[]): Promise<void> {
    this.deletedBatches.push(keys);
    for (const key of keys) this.objects.delete(key);
  }
}

export async function seedUser(name = "Test User") {
  const [row] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      name,
      email: `${randomUUID()}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  if (!row) throw new Error("seedUser failed");
  return row;
}

export async function seedOrg(ownerId: string, memberIds: string[] = []) {
  const [org] = await db
    .insert(organizations)
    .values({
      id: randomUUID(),
      name: "Test Org",
      slug: `org-${randomUUID()}`,
      createdAt: new Date(),
    })
    .returning();
  if (!org) throw new Error("seedOrg failed");
  for (const [index, userId] of [ownerId, ...memberIds].entries()) {
    await db.insert(members).values({
      id: randomUUID(),
      organizationId: org.id,
      userId,
      role: index === 0 ? "owner" : "member",
      createdAt: new Date(),
    });
  }
  return org;
}

export async function seedProvider() {
  const [row] = await db
    .insert(providers)
    .values({
      name: "Test Provider",
      slug: `provider-${randomUUID()}`,
      country: "SG",
      category: "MOBILE_POSTPAID",
      website: "https://provider.example.com",
    })
    .returning();
  if (!row) throw new Error("seedProvider failed");
  return row;
}

export async function seedHolder(
  ownerId: string,
  input: { phone?: string; orgId?: string | null; alias?: string } = {},
) {
  const holderId = randomUUID();
  const phone = input.phone ?? `+65${String(Math.floor(80_000_000 + Math.random() * 19_999_999))}`;
  const row = await db.transaction(async (tx) => {
    const secret = await storeSecret(tx, { holderId, kind: "PHONE", value: phone });
    const [holder] = await tx
      .insert(accountHolders)
      .values({
        id: holderId,
        ownerUserId: ownerId,
        orgId: input.orgId ?? null,
        alias: input.alias ?? "Holder",
        phoneSecretId: secret.id,
      })
      .returning();
    return holder;
  });
  if (!row) throw new Error("seedHolder failed");
  return row;
}

export async function seedAccountSecret(holderId: string) {
  return storeSecret(db, { holderId, kind: "ACCOUNT_NO", value: "ACC-12345678" });
}

export async function seedCase(input: {
  ownerId: string;
  holderId: string;
  providerId?: string | null;
  orgId?: string | null;
  status?: typeof cases.$inferInsert.status;
}) {
  const [row] = await db
    .insert(cases)
    .values({
      ownerUserId: input.ownerId,
      holderId: input.holderId,
      providerId: input.providerId ?? null,
      orgId: input.orgId ?? null,
      serviceType: "MOBILE_POSTPAID",
      status: input.status ?? "AWAITING_MANDATE",
    })
    .returning();
  if (!row) throw new Error("seedCase failed");
  return row;
}

export async function seedMandate(input: {
  caseId: string;
  holderId: string;
  providerId: string;
  serviceSecretId: string;
  delegateUserId?: string | null;
  delegateOrgId?: string | null;
  status?: typeof mandates.$inferInsert.status;
}) {
  const now = new Date();
  const [row] = await db
    .insert(mandates)
    .values({
      caseId: input.caseId,
      holderId: input.holderId,
      delegateUserId: input.delegateUserId ?? null,
      delegateOrgId: input.delegateOrgId ?? null,
      providerId: input.providerId,
      serviceSecretId: input.serviceSecretId,
      actions: ["CANCEL_SERVICE"],
      maxFeeCents: 500,
      status: input.status ?? "PENDING",
      signedAt: input.status === "ACTIVE" ? now : null,
      expiresAt: new Date(now.getTime() + 7 * 86_400_000),
    })
    .returning();
  if (!row) throw new Error("seedMandate failed");
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
      address: "cancel@provider.test",
      acceptsLoa: "YES",
      requiredDocuments: [],
      requiredSecrets: ["NRIC", "FULL_NAME", "ACCOUNT_NO"],
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

export async function seedStep(
  caseId: string,
  overrides: Partial<typeof caseSteps.$inferInsert> = {},
) {
  const [row] = await db
    .insert(caseSteps)
    .values({
      caseId,
      seq: Math.floor(Math.random() * 1_000_000_000),
      tool: "send-notice-email",
      args: {},
      status: "RUNNING",
      requiresApproval: false,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("seedStep failed");
  return row;
}
