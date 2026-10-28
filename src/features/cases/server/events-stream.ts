import { and, eq, inArray, or } from "drizzle-orm";

import { db } from "~/server/db";
import { cases, members } from "~/server/db/schema";
import { ToolError } from "./errors";
import { caseChannel, caseEvents } from "./events";

export interface EventsCaller {
  userId: string;
  orgIds: string[];
}

/** The caller's identity for event auth: user id plus org memberships. */
export async function loadCallerForEvents(userId: string): Promise<EventsCaller> {
  const rows = await db
    .select({ orgId: members.organizationId })
    .from(members)
    .where(eq(members.userId, userId));
  return { userId, orgIds: rows.map((row) => row.orgId) };
}

const EVENT_TYPES = new Set(["status", "step", "transcript", "card", "holder_joined"]);

/** The caller's case, or `NOT_FOUND` when it is missing or someone else's. */
export async function loadOwnedCaseForEvents(caseId: string, caller: EventsCaller) {
  const ownership = [eq(cases.ownerUserId, caller.userId)];
  if (caller.orgIds.length > 0) ownership.push(inArray(cases.orgId, caller.orgIds));
  const [c] = await db
    .select()
    .from(cases)
    .where(and(eq(cases.id, caseId), or(...ownership)))
    .limit(1);
  if (!c) throw new ToolError("NOT_FOUND", "Case not found");
  return c;
}

/**
 * Translate one `case:<id>` channel message into an SSE data payload.
 * Transitions predate the typed envelopes, so `{ from, to }` becomes
 * `{ type: "status", ... }`. Unknown payloads are skipped, never streamed.
 */
export function toCaseEventData(message: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.type === "string" && EVENT_TYPES.has(record.type)) {
    return JSON.stringify(record);
  }
  if (typeof record.from === "string" && typeof record.to === "string") {
    return JSON.stringify({
      type: "status",
      caseId: record.caseId ?? null,
      from: record.from,
      to: record.to,
      at: record.at ?? null,
    });
  }
  return null;
}

export interface StreamCaseEventsOpts {
  signal?: AbortSignal;
}

/**
 * The SSE body for a case: a `status` snapshot first, then every later
 * channel message, translated. Ends when the client disconnects.
 */
export async function* streamCaseEvents(
  caseId: string,
  caller: EventsCaller,
  opts: StreamCaseEventsOpts = {},
): AsyncGenerator<string> {
  const c = await loadOwnedCaseForEvents(caseId, caller);
  yield `data: ${JSON.stringify({ type: "status", caseId, status: c.status })}\n\n`;
  const queue: string[] = [];
  let waiter: (() => void) | null = null;
  const unsubscribe = await caseEvents().subscribe(caseChannel(caseId), (message) => {
    const data = toCaseEventData(message);
    if (!data) return;
    queue.push(`data: ${data}\n\n`);
    waiter?.();
    waiter = null;
  });
  try {
    for (;;) {
      const frame = queue.shift();
      if (frame) {
        yield frame;
        continue;
      }
      if (opts.signal?.aborted) return;
      await new Promise<void>((resolve) => {
        waiter = resolve;
        opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      waiter = null;
      if (opts.signal?.aborted) return;
    }
  } finally {
    await unsubscribe();
  }
}
