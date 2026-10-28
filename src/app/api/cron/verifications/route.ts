import { runVerificationsCron } from "~/features/cases/server/verifications";
import { requireCronSecret } from "~/server/api/cron-auth";
import { logger } from "~/server/logger";

/** Daily verification job. Requires `Authorization: Bearer ${CRON_SECRET}`. */
export async function POST(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;
  try {
    const counts = await runVerificationsCron();
    return Response.json({ ok: true, ...counts });
  } catch (error) {
    logger.error("Verifications job failed", error);
    return Response.json(
      { code: "INTERNAL_ERROR", message: "Verifications job failed" },
      { status: 500 },
    );
  }
}
