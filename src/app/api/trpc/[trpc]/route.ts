import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { NextRequest } from "next/server";
import { limitBody, MAX_BODY_BYTES } from "~/server/api/body-limit";
import { appRouter } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";
import { logger } from "~/server/logger";

/**
 * This wraps the `createTRPCContext` helper and provides the required context for the tRPC API when
 * handling a HTTP request (e.g. when you make requests from Client Components).
 */
const createContext = async (req: NextRequest) => {
  return createTRPCContext({
    headers: req.headers,
  });
};

const handler = async (incoming: NextRequest) => {
  const req = await limitBody(incoming);
  if (!req) {
    return Response.json(
      { error: `Request body exceeds ${MAX_BODY_BYTES} bytes` },
      { status: 413 },
    );
  }
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createContext(incoming),
    // The path and message pass redaction; bodies and query strings are
    // never logged, so request PII cannot reach the logs (spec 0002 B10).
    onError: ({ path, error }) => {
      logger.error(`tRPC failed on ${path ?? "<no-path>"}: ${error.message}`);
    },
  });
};

export { handler as GET, handler as POST };
