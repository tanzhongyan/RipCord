import { Redis } from "iovalkey";

import { logger } from "~/server/logger";
import { env } from "~/shared/config/env";

/**
 * The Valkey commands the case engine needs: one pub/sub channel per case.
 * SSE subscribers share the channel; every payload is a JSON envelope with
 * a `type` of `status`, `step`, `transcript`, `card` or `holder_joined`.
 */
export interface CaseEvents {
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string, onMessage: (message: string) => void): Promise<() => void>;
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

const globalForEvents = globalThis as unknown as {
  caseEvents: CaseEvents | undefined;
  subscriber: Redis | undefined;
};

/**
 * Lazily connected event publisher, cached per process outside production.
 * Publishing is fire-and-forget: the transition already committed, so a down
 * Valkey logs a warning instead of failing the case move. Subscribing uses a
 * second connection, since a subscriber connection cannot publish.
 */
export function caseEvents(): CaseEvents {
  if (override) return override;
  if (!globalForEvents.caseEvents) {
    const redis = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: 3 });
    redis.on("error", () => {
      if (env.NODE_ENV === "development") console.error("Valkey connection error");
    });
    const subscriber = () => {
      if (!globalForEvents.subscriber) {
        globalForEvents.subscriber = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: 3 });
      }
      return globalForEvents.subscriber;
    };
    globalForEvents.caseEvents = {
      publish: (channel, message) => {
        Promise.resolve(redis.publish(channel, message)).catch((error: unknown) => {
          logger.warn(
            `case event publish failed: ${error instanceof Error ? error.message : "unknown"}`,
          );
        });
        return Promise.resolve();
      },
      subscribe: async (channel, onMessage) => {
        const sub = subscriber();
        const handler = (got: string, message: string) => {
          if (got === channel) onMessage(message);
        };
        sub.on("message", handler);
        await sub.subscribe(channel);
        return () => {
          sub.off("message", handler);
          void sub.unsubscribe(channel);
        };
      },
    };
  }
  return globalForEvents.caseEvents;
}
