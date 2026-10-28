import { signMandateSchema } from "~/features/identity/schemas/mandate";
import { signMandate } from "~/features/identity/server/mandate-flow";
import { handleMandateRoute, requestClientInfo } from "~/features/identity/server/mandate-routes";

export async function POST(req: Request, ctx: { params: Promise<{ mandateId: string }> }) {
  return handleMandateRoute(
    req,
    ctx.params,
    signMandateSchema,
    async ({ mandateId, body, sessionUserId, req: request }) => {
      const client = requestClientInfo(request);
      await signMandate(
        {
          mandateId,
          token: body.token,
          code: body.code,
          typedName: body.typedName,
          allowLive: body.allowLive,
          fullName: body.fullName,
          nric: body.nric,
        },
        { ...client, sessionUserId },
      );
      return Response.json({ ok: true });
    },
  );
}
