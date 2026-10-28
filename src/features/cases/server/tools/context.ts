import type { cases } from "~/server/db/schema";
import { createStorage, type StorageClient } from "~/server/storage";

export interface ToolContext {
  userId: string;
  orgIds: string[];
  storage: StorageClient;
  now: () => Date;
}

let storageOverride: StorageClient | null = null;

/** Install a fake `StorageClient` (`null` restores S3). Tests only. */
export function setStorageOverride(client: StorageClient | null): void {
  storageOverride = client;
}

export function liveToolContext(userId: string, orgIds: string[]): ToolContext {
  return { userId, orgIds, storage: storageOverride ?? createStorage(), now: () => new Date() };
}

export type CaseRow = typeof cases.$inferSelect;

/** `llm_usage` owner key for model calls a tool makes. */
export function ownerKeyFor(ctx: ToolContext, c: CaseRow | null): string {
  return c?.orgId ? `org:${c.orgId}` : `user:${ctx.userId}`;
}
