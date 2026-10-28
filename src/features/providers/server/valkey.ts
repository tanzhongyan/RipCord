import { Redis } from "iovalkey";

import { env } from "~/shared/config/env";

/**
 * The Valkey commands the provider knowledge base needs: string cache and
 * rate-limit counters, sets that index cache keys per provider, and lists
 * that hold the last outcome durations per channel. Tests substitute a fake.
 */
export interface ProviderValkey {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  ttl(key: string): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  lpush(key: string, ...elements: string[]): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}

class LiveProviderValkey implements ProviderValkey {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.redis.get(key));
  }

  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown> {
    return Promise.resolve(this.redis.set(key, value, mode, seconds));
  }

  del(...keys: string[]): Promise<unknown> {
    if (keys.length === 0) return Promise.resolve(0);
    return Promise.resolve(this.redis.del(...keys));
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

  sadd(key: string, ...members: string[]): Promise<unknown> {
    return Promise.resolve(this.redis.sadd(key, ...members));
  }

  smembers(key: string): Promise<string[]> {
    return Promise.resolve(this.redis.smembers(key));
  }

  lpush(key: string, ...elements: string[]): Promise<unknown> {
    return Promise.resolve(this.redis.lpush(key, ...elements));
  }

  ltrim(key: string, start: number, stop: number): Promise<unknown> {
    return Promise.resolve(this.redis.ltrim(key, start, stop));
  }

  lrange(key: string, start: number, stop: number): Promise<string[]> {
    return Promise.resolve(this.redis.lrange(key, start, stop));
  }
}

/** Test double. `setValkeyOverride(null)` restores the live client. */
let testDouble: ProviderValkey | null = null;

export function setValkeyOverride(client: ProviderValkey | null): void {
  testDouble = client;
}

const shared = globalThis as unknown as { ripcordProvidersValkey?: ProviderValkey };

function connect(): ProviderValkey {
  const redis = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: 3 });
  redis.on("error", () => {
    if (env.NODE_ENV === "development") console.error("Valkey connection error");
  });
  return new LiveProviderValkey(redis);
}

/** Live client, connected lazily and cached per process outside production. */
export function valkey(): ProviderValkey {
  if (testDouble) return testDouble;
  shared.ripcordProvidersValkey ??= connect();
  return shared.ripcordProvidersValkey;
}
