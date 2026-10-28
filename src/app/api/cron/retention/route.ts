import { requireCronSecret } from "~/server/api/cron-auth";
import { logger } from "~/server/logger";
import { runRetentionJob } from "~/server/retention";

/** Daily retention job. Requires `Authorization: Bearer ${CRON_SECRET}`. */
export async function POST(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;
  try {
    const counts = await runRetentionJob(new Date());
    return Response.json({ ok: true, ...counts });
  } catch (error) {
    logger.error("Retention job failed", error);
    return Response.json(
      { code: "INTERNAL_ERROR", message: "Retention job failed" },
      { status: 500 },
    );
  }
}
