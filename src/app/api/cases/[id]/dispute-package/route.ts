import { z } from "zod";

import { renderDisputePackageForOwner } from "~/features/cases";
import { authorizeCaseRoute } from "~/features/cases/server/events-stream";

/** `?chargeCents`: minor units, non-negative, capped. Invalid input is a 400. */
const disputeQuerySchema = z.object({
  chargeCents: z.coerce.number().int().min(0).max(100_000_000).optional(),
});

/**
 * `GET /api/cases/[id]/dispute-package`: the resolved dispute PDF for the
 * case owner only. The rendered copy is never stored.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const query = disputeQuerySchema.safeParse({
    chargeCents: url.searchParams.get("chargeCents") ?? undefined,
  });
  if (!query.success) {
    return Response.json({ code: "VALIDATION", message: "Invalid chargeCents" }, { status: 400 });
  }
  const authed = await authorizeCaseRoute(req, id);
  if ("response" in authed) return authed.response;
  const bytes = await renderDisputePackageForOwner(id, query.data.chargeCents ?? null);
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="dispute-${id}.pdf"`,
    },
  });
}
