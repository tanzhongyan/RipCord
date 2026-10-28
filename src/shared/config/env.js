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
