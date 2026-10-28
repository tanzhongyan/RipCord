import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";

import { db } from "~/server/db";
import { cases } from "~/server/db/schema";
import { containsStrongPii } from "~/server/vault";
import type { CaseStatus } from "../engine";
import { ToolError } from "../errors";
import { caseToolDefs } from "./case-tools";
import type { CaseRow, ToolContext } from "./context";
import { lookupToolDefs } from "./lookup-tools";

export type ToolBudget = "read" | "write";

export interface ToolDef<TInput = unknown, TOutput = unknown> {
  name: string;
  budget: ToolBudget;
  /** True means the input must include `confirm: true`. */
  confirm: boolean;
  /**
   * Case statuses the tool may run in. Null skips case loading (tools
   * without a case); anything else loads the caller's case first.
   */
  statuses: ReadonlyArray<CaseStatus> | null;
  input: z.ZodType<TInput>;
  handler: (input: TInput, ctx: ToolContext, c: CaseRow | null) => Promise<TOutput>;
}

/**
 * Executor-only tools (spec 0005). Never exposed to chat or MCP: the
 * registry answers `UNKNOWN_TOOL` for them, exactly like unknown names.
 */
export const EXECUTOR_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "send-notice-email",
  "place-call",
  "send-digits",
  "bridge-holder",
  "hang-up",
]);

const REGISTRY: ReadonlyMap<string, ToolDef> = new Map(
  [...lookupToolDefs(), ...caseToolDefs()].map((def) => [def.name, def as ToolDef]),
);

/** Every tool the registry serves, for the chat and MCP layers (spec 0006). */
export function listTools(): Array<Pick<ToolDef, "name" | "budget" | "confirm" | "statuses">> {
  return [...REGISTRY.values()].map((def) => ({
    name: def.name,
    budget: def.budget,
    confirm: def.confirm,
    statuses: def.statuses,
  }));
}

async function loadOwnedCase(caseId: string, ctx: ToolContext): Promise<CaseRow> {
  const ownership = [eq(cases.ownerUserId, ctx.userId)];
  if (ctx.orgIds.length > 0) ownership.push(inArray(cases.orgId, ctx.orgIds));
  const [c] = await db
    .select()
    .from(cases)
    .where(and(eq(cases.id, caseId), or(...ownership)))
    .limit(1);
  if (!c) throw new ToolError("NOT_FOUND", "Case not found");
  return c;
}

/**
 * Run one registry tool. Every input passes the PII guard, its Zod schema
 * and the confirm gate; every case-scoped tool loads the caller's case
 * (`NOT_FOUND` otherwise) and checks its status. Unknown and
 * executor-only names answer `UNKNOWN_TOOL`.
 */
export async function callTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  const def = EXECUTOR_ONLY_TOOLS.has(name) ? undefined : REGISTRY.get(name);
  if (!def) throw new ToolError("UNKNOWN_TOOL", `Unknown tool: ${name}`);
  if (containsStrongPii(rawInput)) {
    throw new ToolError(
      "PII_NOT_ALLOWED",
      "Do not send personal identifiers here. The holder enters them on the secure page.",
    );
  }
  let input: unknown;
  try {
    input = def.input.parse(rawInput);
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : "Invalid input";
    throw new ToolError("VALIDATION", message ?? "Invalid input");
  }
  if (
    def.confirm &&
    (typeof input !== "object" ||
      input === null ||
      (input as { confirm?: unknown }).confirm !== true)
  ) {
    throw new ToolError("CONFIRM_REQUIRED", `Calling ${name} needs confirm: true`);
  }
  let c: CaseRow | null = null;
  if (def.statuses !== null) {
    const caseId = (input as { caseId?: unknown }).caseId;
    if (typeof caseId !== "string") throw new ToolError("VALIDATION", "caseId is required");
    c = await loadOwnedCase(caseId, ctx);
    if (!def.statuses.includes(c.status)) {
      throw new ToolError("ILLEGAL_TRANSITION", `${name} cannot run while the case is ${c.status}`);
    }
  }
  return def.handler(input, ctx, c);
}
