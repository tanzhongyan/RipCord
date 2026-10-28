import { renderDisputePackageForOwner } from "~/features/cases";
import { authorizeCaseRoute } from "~/features/cases/server/events-stream";

/**
 * `GET /api/cases/[id]/dispute-package`: the resolved dispute PDF for the
 * case owner only. The rendered copy is never stored.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const authed = await authorizeCaseRoute(req, id);
  if ("response" in authed) return authed.response;
  const url = new URL(req.url);
  const charge = url.searchParams.get("chargeCents");
  const disputedChargeCents = charge ? Number(charge) : null;
  const bytes = await renderDisputePackageForOwner(
    id,
    Number.isInteger(disputedChargeCents) ? (disputedChargeCents as number) : null,
  );
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="dispute-${id}.pdf"`,
    },
  });
}
