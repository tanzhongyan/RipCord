import { createHash, randomUUID } from "node:crypto";

import { desc, eq } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";

import { db } from "~/server/db";
import {
  accountHolders,
  billingCustomers,
  caseDocuments,
  caseSteps,
  cases,
  communications,
  contractTerms,
  creditLedger,
  mandates,
  providerChannels,
  providerPolicies,
  providers,
  users,
} from "~/server/db/schema";
import type { StorageClient } from "~/server/storage";
import { storeSecret } from "~/server/vault";
import type { CaseEvents } from "./events";
import type { MailMessage, MailTransport } from "./mailer";
import type { ToolContext } from "./tools/context";

/** Recording event fake. Subscribers receive later publishes on their channel. */
export class FakeEvents implements CaseEvents {
  readonly published: Array<{ channel: string; message: string }> = [];
  private readonly subscribers = new Map<string, Set<(message: string) => void>>();

  async publish(channel: string, message: string): Promise<unknown> {
    this.published.push({ channel, message });
    for (const onMessage of this.subscribers.get(channel) ?? []) onMessage(message);
    return 1;
  }

  async subscribe(channel: string, onMessage: (message: string) => void): Promise<() => void> {
    let set = this.subscribers.get(channel);
    if (!set) {
      set = new Set();
      this.subscribers.set(channel, set);
    }
    set.add(onMessage);
    return () => {
      this.subscribers.get(channel)?.delete(onMessage);
    };
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

/** In-memory SMTP outbox. `failuresLeft` makes the next sends throw. */
export class FakeMailTransport implements MailTransport {
  readonly sent: MailMessage[] = [];
  failuresLeft = 0;

  async sendMail(message: MailMessage): Promise<{ messageId: string }> {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error("FakeMailTransport: send failed");
    }
    this.sent.push(message);
    return { messageId: `<fake-${this.sent.length}@ripcord.test>` };
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

// A minimal valid 1x1 baseline JPEG, the payload of scanned-page fixtures.
const SCAN_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
  0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
  0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
  0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
  0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
  0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d, 0x01, 0x02, 0x03, 0x00,
  0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32,
  0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
  0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35,
  0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55,
  0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
  0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94,
  0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2,
  0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
  0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6,
  0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda,
  0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x37, 0xff, 0xd9,
]);

/** A multi-page scanned bill PDF: embedded JPEGs, no text layer. */
export async function buildScannedPdf(pages = 3): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage();
    const img = await doc.embedJpg(SCAN_JPEG);
    page.drawImage(img, { x: 50, y: 600, width: 200, height: 200 });
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
  liveModeApproved?: boolean;
  loaDocumentId?: string | null;
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
      liveModeApproved: input.liveModeApproved ?? false,
      signedAt: input.status === "ACTIVE" ? now : null,
      expiresAt: new Date(now.getTime() + 7 * 86_400_000),
      loaDocumentId: input.loaDocumentId ?? null,
    })
    .returning();
  if (!row) throw new Error("seedMandate failed");
  return row;
}

/**
 * A handed-off live call: an `EXECUTING` case with an `ACTIVE` mandate, a
 * `PHONE_IVR` channel, a `RUNNING` approved `place-call` step, and the
 * `OUTBOUND` handoff row the worker and status callback resolve by.
 */
export async function seedLiveCall(
  input: {
    address?: string;
    ivrPath?: Array<{ prompt: string; digits: string }> | null;
    callSid?: string;
    accountNo?: string;
  } = {},
) {
  const user = await seedUser();
  const provider = await seedProvider({ name: "Demo Telco" });
  const holder = await seedHolder(user.id);
  const account = await seedAccountSecret(holder.id, input.accountNo);
  const c = await seedCase({
    ownerId: user.id,
    holderId: holder.id,
    providerId: provider.id,
    serviceType: "MOBILE_POSTPAID",
    status: "EXECUTING",
  });
  const channel = await seedChannel(provider.id, {
    kind: "PHONE_IVR",
    serviceType: null,
    address: input.address ?? "+15005550006",
    ivrPath: input.ivrPath === undefined ? null : input.ivrPath,
    requiredSecrets: ["FULL_NAME", "NRIC", "ACCOUNT_NO"],
  });
  await seedMandate({
    caseId: c.id,
    holderId: holder.id,
    providerId: provider.id,
    serviceSecretId: account.id,
    status: "ACTIVE",
  });
  const step = await seedStep(c.id, {
    seq: 1,
    tool: "place-call",
    args: { providerChannelId: channel.id, kind: "PHONE_IVR" },
    status: "RUNNING",
    requiresApproval: true,
    approvedAt: new Date(),
    approvedByUserId: user.id,
  });
  const callSid = input.callSid ?? `CA${randomUUID().replace(/-/g, "").slice(0, 28)}`;
  await db.insert(communications).values({
    caseId: c.id,
    stepId: step.id,
    channel: "PHONE_IVR",
    direction: "OUTBOUND",
    body: "Call placed",
    externalRef: callSid,
    occurredAt: new Date(),
  });
  return { user, holder, c, channel, step, callSid };
}

/** The current status and result of one step. */
export async function readStep(stepId: string) {
  const [row] = await db
    .select({ status: caseSteps.status, result: caseSteps.result })
    .from(caseSteps)
    .where(eq(caseSteps.id, stepId))
    .limit(1);
  return row;
}

/** The current status of one case. */
export async function readCaseStatus(caseId: string) {
  const [row] = await db
    .select({ status: cases.status })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1);
  return row?.status;
}

/** Mark one step `SUCCEEDED` with a result, skipping the engine. */
export async function succeedStep(stepId: string, result: Record<string, unknown>) {
  await db
    .update(caseSteps)
    .set({ status: "SUCCEEDED", result, finishedAt: new Date() })
    .where(eq(caseSteps.id, stepId));
}

/** A signed-LOA stand-in: a one-page PDF whose text names the given tokens. */
export async function seedLoaDocument(
  caseId: string,
  tokens: { fullName: string; nric: string; accountNo: string },
) {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = [
    "Letter of Authorisation",
    `I, ${tokens.fullName}, holder of identification ${tokens.nric}, authorise the delegate.`,
    `Account only: ${tokens.accountNo}.`,
  ];
  let y = 750;
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 11, font });
    y -= 20;
  }
  const bytes = await doc.save();
  const [row] = await db
    .insert(caseDocuments)
    .values({
      caseId,
      kind: "LOA",
      storageKey: `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })
    .returning();
  if (!row) throw new Error("seedLoaDocument failed");
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

/** The newest mandate for a case, or undefined when none exists. */
export async function findMandateForCase(caseId: string) {
  const [row] = await db
    .select({ id: mandates.id, status: mandates.status })
    .from(mandates)
    .where(eq(mandates.caseId, caseId))
    .orderBy(desc(mandates.createdAt))
    .limit(1);
  return row;
}

export async function seedPolicy(
  providerId: string,
  overrides: Partial<typeof providerPolicies.$inferInsert> = {},
) {
  const [row] = await db
    .insert(providerPolicies)
    .values({
      providerId,
      kind: "NOTICE_PERIOD",
      rule: { days: 30 },
      excerpt: "30 days notice.",
      sourceUrl: "https://provider.example.com/terms",
      checkedAt: new Date(),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("seedPolicy failed");
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
