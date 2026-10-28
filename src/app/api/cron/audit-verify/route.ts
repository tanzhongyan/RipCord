import { requireCronSecret } from "~/server/api/cron-auth";
import { verifyAuditChainJob } from "~/server/audit";
import { logger } from "~/server/logger";

/** Daily audit-chain check. Requires `Authorization: Bearer ${CRON_SECRET}`. */
export async function POST(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;
  const result = await verifyAuditChainJob();
  if (!result.ok) {
    logger.error(`Audit chain break at row ${result.breakAtId}`);
    return Response.json({ ok: false, breakAtId: result.breakAtId }, { status: 500 });
  }
  return Response.json({ ok: true, checked: result.checked });
}
