import { linkTokenSchema } from "~/features/identity/schemas/mandate";
import { declineMandate } from "~/features/identity/server/mandate-flow";
import { handleMandateRoute } from "~/features/identity/server/mandate-routes";

export async function POST(req: Request, ctx: { params: Promise<{ mandateId: string }> }) {
  return handleMandateRoute(
    req,
    ctx.params,
    linkTokenSchema,
    async ({ mandateId, body, sessionUserId }) => {
      await declineMandate({ mandateId, token: body.token }, sessionUserId);
      return Response.json({ ok: true });
    },
  );
}
