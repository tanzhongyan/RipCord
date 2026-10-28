import { Redis } from "iovalkey";

import { env } from "~/shared/config/env";

/** The Valkey commands the mandate flow needs. Tests substitute a fake. */
export interface ValkeyClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  /** Atomic `SET key value EX seconds NX`: true when this caller won the key. */
  setNx(key: string, value: string, mode: "EX", seconds: number): Promise<boolean>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  ttl(key: string): Promise<number>;
  del(key: string): Promise<unknown>;
}

class IovalkeyClient implements ValkeyClient {
  constructor(private readonly redis: Redis) {}

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.redis.get(key));
  }

  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown> {
    return Promise.resolve(this.redis.set(key, value, mode, seconds));
  }

  async setNx(key: string, value: string, mode: "EX", seconds: number): Promise<boolean> {
    const result = await this.redis.set(key, value, mode, seconds, "NX");
    return result === "OK";
  }

  incr(key: string): Promise<number> {
    return Promise.resolve(this.redis.incr(key));
  }

  expire(key: string, seconds: number): Promise<unknown> {
    return Promise.resolve(this.redis.expire(key, seconds));
  }

  ttl(key: string): Promise<number> {
    return Promise.resolve(this.redis.ttl(key));
  }

  del(key: string): Promise<unknown> {
    return Promise.resolve(this.redis.del(key));
  }
}

let override: ValkeyClient | null = null;

/** Test seam: substitute a fake Valkey client. Pass null to restore the real one. */
export function setValkeyOverride(client: ValkeyClient | null): void {
  override = client;
}

const globalForValkey = globalThis as unknown as { valkey: ValkeyClient | undefined };

/** Lazily connected Valkey client, cached per process outside production. */
export function valkey(): ValkeyClient {
  if (override) return override;
  if (!globalForValkey.valkey) {
    const redis = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: 3 });
    redis.on("error", () => {
      if (env.NODE_ENV === "development") console.error("Valkey connection error");
    });
    globalForValkey.valkey = new IovalkeyClient(redis);
  }
  return globalForValkey.valkey;
}
