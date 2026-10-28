import { z } from "zod";

import { auth } from "~/server/auth/auth";
import { toRouteResponse } from "./mandate-flow";

export interface MandateRouteContext<T> {
  mandateId: string;
  body: T;
  sessionUserId: string | null;
  req: Request;
}

/** Parse and authorise a holder route call, mapping every failure to a coded response. */
export async function handleMandateRoute<T>(
  req: Request,
  params: Promise<{ mandateId: string }>,
  schema: z.ZodType<T>,
  run: (ctx: MandateRouteContext<T>) => Promise<Response>,
): Promise<Response> {
  try {
    const { mandateId } = await params;
    const body = schema.parse(await req.json().catch(() => ({})));
    const session = await auth.api.getSession({ headers: req.headers });
    return await run({ mandateId, body, sessionUserId: session?.user.id ?? null, req });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ code: "VALIDATION", message: "Invalid request" }, { status: 400 });
    }
    return toRouteResponse(error);
  }
}

/** Best-effort client identity for signature evidence (stored hashed). */
export function requestClientInfo(req: Request): { ip: string; userAgent: string } {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    ip: forwarded || req.headers.get("x-real-ip")?.trim() || "unknown",
    userAgent: req.headers.get("user-agent") ?? "unknown",
  };
}
