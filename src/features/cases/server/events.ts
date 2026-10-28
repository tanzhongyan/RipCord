import { Redis } from "iovalkey";

import { logger } from "~/server/logger";
import { env } from "~/shared/config/env";

/** The Valkey commands the case engine needs: one pub/sub channel per case. */
export interface CaseEvents {
  publish(channel: string, message: string): Promise<unknown>;
}

/** Live-UI channel for a case: `case:<id>`. */
export function caseChannel(caseId: string): string {
  return `case:${caseId}`;
}

let override: CaseEvents | null = null;

/** Test seam: substitute a recording fake. Pass null to restore the live client. */
export function setEventsOverride(events: CaseEvents | null): void {
  override = events;
}

const globalForEvents = globalThis as unknown as { caseEvents: CaseEvents | undefined };

/**
 * Lazily connected event publisher, cached per process outside production.
 * Publishing is fire-and-forget: the transition already committed, so a down
 * Valkey logs a warning instead of failing the case move.
 */
export function caseEvents(): CaseEvents {
  if (override) return override;
  if (!globalForEvents.caseEvents) {
    const redis = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: 3 });
    redis.on("error", () => {
      if (env.NODE_ENV === "development") console.error("Valkey connection error");
    });
    globalForEvents.caseEvents = {
      publish: (channel, message) => {
        Promise.resolve(redis.publish(channel, message)).catch((error: unknown) => {
          logger.warn(
            `case event publish failed: ${error instanceof Error ? error.message : "unknown"}`,
          );
        });
        return Promise.resolve();
      },
    };
  }
  return globalForEvents.caseEvents;
}
