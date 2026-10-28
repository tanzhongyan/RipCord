import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * Optional in development and test, required when serving production. RipCord
 * refuses to start in production without Twilio, and falls back to a console
 * sink otherwise (spec 0001). `scripts/build.mjs` fills placeholders for
 * `next build`, which only compiles; the running server always validates the
 * real environment.
 */
/** @param {string} name */
const productionRequired = (name) =>
  z
    .string()
    .min(1)
    .optional()
    .refine((v) => process.env.NODE_ENV !== "production" || !!v, {
      message: `${name} is required in production`,
    });

/** True when `value` is base64 for exactly 32 bytes (spec 0002 master key). */
/** @param {unknown} value */
const isBase64Bytes32 = (value) => {
  if (typeof value !== "string") return false;
  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
};

export const env = createEnv({
  /**
   * Server-side variables. Reading one that fails validation stops the build and the server.
   */
  server: {
    DATABASE_URL: z.string().url(),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    BETTER_AUTH_SECRET: z.string().min(1).optional(),
    BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
    TWILIO_ACCOUNT_SID: productionRequired("TWILIO_ACCOUNT_SID"),
    TWILIO_AUTH_TOKEN: productionRequired("TWILIO_AUTH_TOKEN"),
    TWILIO_SMS_FROM: productionRequired("TWILIO_SMS_FROM"),
    VALKEY_URL: z.string().url().default("redis://localhost:6379"),
    SMTP_URL: z.string().url().default("smtp://localhost:1025"),
    MAIL_FROM: z.string().min(1).default("RipCord <noreply@ripcord.local>"),
    VAULT_MASTER_KEY: z
      .string()
      .min(1)
      .optional()
      .refine((v) => v === undefined || isBase64Bytes32(v), {
        message: "VAULT_MASTER_KEY must be base64 for 32 bytes",
      })
      .refine((v) => process.env.NODE_ENV !== "production" || !!v, {
        message: "VAULT_MASTER_KEY is required in production",
      }),
    VAULT_KEY_VERSION: z.coerce.number().int().min(1).default(1),
    CRON_SECRET: productionRequired("CRON_SECRET"),
    S3_ENDPOINT: z.string().url().default("http://localhost:9100"),
    S3_BUCKET: z.string().min(1).default("ripcord"),
    S3_ACCESS_KEY: productionRequired("S3_ACCESS_KEY"),
    S3_SECRET_KEY: productionRequired("S3_SECRET_KEY"),
    ADMIN_EMAILS: z.string().optional(),
    META_API_KEY: z.string().min(1).optional(),
    META_BASE_URL: z.string().url().default("https://api.meta.ai/v1"),
    MODEL_STANDARD: z.string().min(1).default("muse-spark-1.3"),
    MODEL_CONTRIBUTOR: z.string().min(1).default("muse-spark-1.3-contributor"),
    MODEL_PROVIDER: z.enum(["meta", "fake"]).default("fake"),
    MODEL_PRICES_JSON: z.string().min(1).default('{"default":{"input":1,"output":3}}'),
    MODEL_BUDGET_USER_MICROS: z.coerce.number().int().min(0).default(2000000),
    MODEL_BUDGET_ORG_MICROS: z.coerce.number().int().min(0).default(20000000),
  },

  /**
   * Client-side variables. Prefix each with `NEXT_PUBLIC_`.
   */
  client: {
    // NEXT_PUBLIC_CLIENTVAR: z.string(),
  },

  /**
   * Next.js edge runtimes and client bundles cannot destructure `process.env`, so list each
   * variable here.
   */
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    TWILIO_SMS_FROM: process.env.TWILIO_SMS_FROM,
    VALKEY_URL: process.env.VALKEY_URL,
    SMTP_URL: process.env.SMTP_URL,
    MAIL_FROM: process.env.MAIL_FROM,
    VAULT_MASTER_KEY: process.env.VAULT_MASTER_KEY,
    VAULT_KEY_VERSION: process.env.VAULT_KEY_VERSION,
    CRON_SECRET: process.env.CRON_SECRET,
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_BUCKET: process.env.S3_BUCKET,
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY,
    S3_SECRET_KEY: process.env.S3_SECRET_KEY,
    ADMIN_EMAILS: process.env.ADMIN_EMAILS,
    META_API_KEY: process.env.META_API_KEY,
    META_BASE_URL: process.env.META_BASE_URL,
    MODEL_STANDARD: process.env.MODEL_STANDARD,
    MODEL_CONTRIBUTOR: process.env.MODEL_CONTRIBUTOR,
    MODEL_PROVIDER: process.env.MODEL_PROVIDER,
    MODEL_PRICES_JSON: process.env.MODEL_PRICES_JSON,
    MODEL_BUDGET_USER_MICROS: process.env.MODEL_BUDGET_USER_MICROS,
    MODEL_BUDGET_ORG_MICROS: process.env.MODEL_BUDGET_ORG_MICROS,
    // NEXT_PUBLIC_CLIENTVAR: process.env.NEXT_PUBLIC_CLIENTVAR,
  },
  /**
   * Set `SKIP_ENV_VALIDATION` to skip validation, for example in Docker builds.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  /**
   * Treat empty strings as undefined, so `SOME_VAR=''` fails a required variable.
   */
  emptyStringAsUndefined: true,
});
