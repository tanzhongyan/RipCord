import { handleStripeEvent } from "~/features/billing";
import { stripeClient } from "~/features/billing/server/stripe";
import { logger } from "~/server/logger";

export const dynamic = "force-dynamic";

/**
 * `POST /api/stripe/webhook`: Stripe events, raw body, signature checked.
 * Handles `checkout.session.completed` (payment), `invoice.paid` and
 * `customer.subscription.deleted`. Unknown events return 200; a bad
 * signature returns 400 and writes nothing.
 */
export async function POST(req: Request) {
  const payload = await req.text();
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return Response.json({ code: "VALIDATION", message: "Missing signature" }, { status: 400 });
  }
  let event: unknown;
  try {
    event = stripeClient().constructEvent(payload, signature);
  } catch (error) {
    logger.error("Stripe webhook signature check failed", error);
    return Response.json({ code: "VALIDATION", message: "Invalid signature" }, { status: 400 });
  }
  try {
    await handleStripeEvent(event);
  } catch (error) {
    logger.error("Stripe webhook handling failed", error);
    return Response.json(
      { code: "INTERNAL_ERROR", message: "Webhook handling failed" },
      { status: 500 },
    );
  }
  return Response.json({ received: true });
}
