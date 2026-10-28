import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  /**
   * Server-side variables. Reading one that fails validation stops the build and the server.
   */
  server: {
    DATABASE_URL: z.string().url(),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /**
     * Honour the `x-user-id` request header as the caller identity. Defaults to false, which
     * rejects every request with UNAUTHORIZED. Set it only behind a gateway that sets the header.
     */
    TRUST_IDENTITY_HEADER: z.stringbool().default(false),
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
    TRUST_IDENTITY_HEADER: process.env.TRUST_IDENTITY_HEADER,
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
