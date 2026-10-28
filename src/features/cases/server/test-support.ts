import { createHash, randomUUID } from "node:crypto";

import { PDFDocument, StandardFonts } from "pdf-lib";

import { db } from "~/server/db";
import {
  accountHolders,
  billingCustomers,
  caseSteps,
  cases,
  contractTerms,
  creditLedger,
  mandates,
  providerChannels,
  providers,
  users,
} from "~/server/db/schema";
import type { StorageClient } from "~/server/storage";
import { storeSecret } from "~/server/vault";
import type { CaseEvents } from "./events";
import type { ToolContext } from "./tools/context";

/** Recording event fake. */
export class FakeEvents implements CaseEvents {
  readonly published: Array<{ channel: string; message: string }> = [];

  async publish(channel: string, message: string): Promise<unknown> {
    this.published.push({ channel, message });
    return 1;
  }
}

/** In-memory object-store double. */
export class FakeStorage implements StorageClient {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly presigned: Array<{ key: string; contentType: string }> = [];

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<{ sha256: string }> {
    this.objects.set(key, { bytes, contentType });
    return { sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  async get(key: string): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`FakeStorage: missing key ${key}`);
    return object.bytes;
  }

  async presignUpload(key: string, contentType: string): Promise<{ url: string }> {
    this.presigned.push({ key, contentType });
    return { url: `https://storage.test/${key}` };
  }

  async del(keys: string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
  }
}

export function testToolContext(
  userId: string,
  orgIds: string[] = [],
  overrides: Partial<Pick<ToolContext, "storage" | "now">> = {},
): ToolContext {
  return {
    userId,
    orgIds,
    storage: overrides.storage ?? new FakeStorage(),
    now: overrides.now ?? (() => new Date()),
  };
}

/** In-memory Valkey double covering the identity and provider shapes. */
export class FakeValkey {
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
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    this.lists.set(key, list.slice(start, end));
    return "OK";
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(start, end);
  }
}

export interface SmsOutbox {
  sender: (to: string, body: string) => Promise<void>;
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

/** A one-page bill PDF with a real text layer, for extraction tests. */
export async function buildBillPdf(lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let y = 750;
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 12, font });
    y -= 20;
  }
  return doc.save();
}

export async function seedUser() {
  const [row] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      name: "Case User",
      email: `${randomUUID()}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  if (!row) throw new Error("seedUser failed");
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

export async function seedProvider(input: { slug?: string; name?: string } = {}) {
  const [row] = await db
    .insert(providers)
    .values({
      name: input.name ?? "Demo Telco",
      slug: input.slug ?? `demo-telco-${randomUUID()}`,
      country: "SG",
      category: "MOBILE_POSTPAID",
      website: "https://demo-telco.test",
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
      serviceType: null,
      kind: "EMAIL",
      address: `cancel-${randomUUID()}@demo-telco.test`,
      acceptsLoa: "YES",
      requiredDocuments: [],
      requiredSecrets: [],
      isVerifiedDestination: true,
      sourceUrl: "https://demo-telco.test/cancel",
      checkedAt: new Date(),
      confidence: 100,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("seedChannel failed");
  return row;
}

export async function seedCase(input: {
  ownerId: string;
  holderId: string;
  providerId?: string | null;
  orgId?: string | null;
  serviceType?: typeof cases.$inferInsert.serviceType;
  status?: typeof cases.$inferInsert.status;
}) {
  const [row] = await db
    .insert(cases)
    .values({
      ownerUserId: input.ownerId,
      holderId: input.holderId,
      providerId: input.providerId ?? null,
      orgId: input.orgId ?? null,
      serviceType: input.serviceType ?? null,
      status: input.status ?? "DRAFT",
    })
    .returning();
  if (!row) throw new Error("seedCase failed");
  return row;
}

export async function seedTerms(
  caseId: string,
  overrides: Partial<typeof contractTerms.$inferInsert> = {},
) {
  const [row] = await db
    .insert(contractTerms)
    .values({
      caseId,
      contractEndDate: null,
      minTermMonths: null,
      etfEstimateCents: null,
      monthlyFeeCents: 5000,
      currency: "SGD",
      noticeDays: 30,
      equipment: [],
      bundleLinks: [],
      confidence: 100,
      evidence: [],
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("seedTerms failed");
  return row;
}

export async function seedAccountSecret(holderId: string, value = "ACC-12345678") {
  return storeSecret(db, { holderId, kind: "ACCOUNT_NO", value });
}

export async function seedMandate(input: {
  caseId: string;
  holderId: string;
  providerId: string;
  serviceSecretId: string;
  status?: typeof mandates.$inferInsert.status;
}) {
  const now = new Date();
  const [row] = await db
    .insert(mandates)
    .values({
      caseId: input.caseId,
      holderId: input.holderId,
      delegateUserId: null,
      delegateOrgId: null,
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

export async function seedBillingCustomer(input: {
  userId?: string | null;
  orgId?: string | null;
}) {
  const [row] = await db
    .insert(billingCustomers)
    .values({
      userId: input.userId ?? null,
      orgId: input.orgId ?? null,
      stripeCustomerId: `cus_${randomUUID()}`,
      plan: "INDIVIDUAL",
    })
    .returning();
  if (!row) throw new Error("seedBillingCustomer failed");
  return row;
}

export async function seedCredit(
  billingCustomerId: string,
  input: {
    delta: number;
    reason?: typeof creditLedger.$inferInsert.reason;
    caseId?: string | null;
  } = { delta: 1 },
) {
  const [row] = await db
    .insert(creditLedger)
    .values({
      billingCustomerId,
      delta: input.delta,
      reason: input.reason ?? "PURCHASE",
      caseId: input.caseId ?? null,
    })
    .returning();
  if (!row) throw new Error("seedCredit failed");
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
      tool: "execute-channel",
      args: {},
      status: "PLANNED",
      requiresApproval: false,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("seedStep failed");
  return row;
}
