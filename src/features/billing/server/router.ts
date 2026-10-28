import { TRPCError } from "@trpc/server";
import { count, desc, eq } from "drizzle-orm";

import { liveAdminDeps, requireAdmin } from "~/features/providers";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { creditLedger, members } from "~/server/db/schema";
import { env } from "~/shared/config/env";
import {
  balanceSchema,
  checkoutSchema,
  LEDGER_PAGE_SIZE,
  ledgerSchema,
  portalSchema,
  subscribeSchema,
} from "../schemas/billing";
import { cachedBalance } from "./balance";
import { findBillingCustomer, findOrCreateBillingCustomer } from "./customers";
import { isStripeConfigured, stripeClient } from "./stripe";

async function requireOrgOwner(userId: string, orgId: string): Promise<void> {
  const rows = await db
    .select({ organizationId: members.organizationId, role: members.role })
    .from(members)
    .where(eq(members.userId, userId));
  const membership = rows.find((entry) => entry.organizationId === orgId);
  if (membership?.role !== "owner") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only org owners can manage the plan" });
  }
}

function requirePrice(value: string | undefined, name: string): string {
  if (!value)
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `${name} is not configured` });
  return value;
}

export const billingRouter = createTRPCRouter({
  balance: protectedProcedure.input(balanceSchema).query(async ({ ctx, input }) => {
    if (input.orgId && !ctx.orgIds.includes(input.orgId)) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Organisation not found" });
    }
    const customer = await findBillingCustomer(ctx.db, {
      userId: ctx.userId,
      orgId: input.orgId ?? null,
    });
    if (!customer) return { balance: 0, plan: "INDIVIDUAL" as const };
    const balance = await cachedBalance(ctx.db, customer.id);
    return { balance, plan: customer.plan };
  }),

  ledger: protectedProcedure.input(ledgerSchema).query(async ({ ctx, input }) => {
    if (input.orgId && !ctx.orgIds.includes(input.orgId)) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Organisation not found" });
    }
    const customer = await findBillingCustomer(ctx.db, {
      userId: ctx.userId,
      orgId: input.orgId ?? null,
    });
    if (!customer) return { rows: [], page: input.page, pageSize: LEDGER_PAGE_SIZE, total: 0 };
    const [rows, counted] = await Promise.all([
      ctx.db
        .select()
        .from(creditLedger)
        .where(eq(creditLedger.billingCustomerId, customer.id))
        .orderBy(desc(creditLedger.createdAt))
        .limit(LEDGER_PAGE_SIZE)
        .offset((input.page - 1) * LEDGER_PAGE_SIZE),
      ctx.db
        .select({ n: count() })
        .from(creditLedger)
        .where(eq(creditLedger.billingCustomerId, customer.id)),
    ]);
    return {
      rows,
      page: input.page,
      pageSize: LEDGER_PAGE_SIZE,
      total: Number(counted[0]?.n ?? 0),
    };
  }),

  checkout: protectedProcedure.input(checkoutSchema).mutation(async ({ ctx, input }) => {
    if (!isStripeConfigured()) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Stripe is not configured" });
    }
    if (input.orgId && !ctx.orgIds.includes(input.orgId)) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Organisation not found" });
    }
    const customer = await findOrCreateBillingCustomer(ctx.db, {
      userId: ctx.userId,
      orgId: input.orgId ?? null,
    });
    const hasOrgPlan = customer.plan === "ORG_MONTHLY";
    const price = hasOrgPlan
      ? requirePrice(env.STRIPE_PRICE_CREDIT_ORG, "STRIPE_PRICE_CREDIT_ORG")
      : requirePrice(env.STRIPE_PRICE_CREDIT, "STRIPE_PRICE_CREDIT");
    const session = await stripeClient().createCheckoutSession({
      priceId: price,
      quantity: input.quantity,
      customerId: customer.stripeCustomerId,
      mode: "payment",
      metadata: {
        billingCustomerId: customer.id,
        quantity: String(input.quantity),
      },
    });
    return { url: session.url };
  }),

  subscribe: protectedProcedure.input(subscribeSchema).mutation(async ({ ctx, input }) => {
    if (!isStripeConfigured()) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Stripe is not configured" });
    }
    await requireOrgOwner(ctx.userId, input.orgId);
    const customer = await findOrCreateBillingCustomer(ctx.db, {
      userId: ctx.userId,
      orgId: input.orgId,
    });
    const price = requirePrice(env.STRIPE_PRICE_ORG_MONTHLY, "STRIPE_PRICE_ORG_MONTHLY");
    const session = await stripeClient().createCheckoutSession({
      priceId: price,
      quantity: 1,
      customerId: customer.stripeCustomerId,
      mode: "subscription",
      metadata: { billingCustomerId: customer.id, orgId: input.orgId },
    });
    return { url: session.url };
  }),

  portal: protectedProcedure.input(portalSchema).mutation(async ({ ctx, input }) => {
    if (!isStripeConfigured()) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Stripe is not configured" });
    }
    if (input.orgId && !ctx.orgIds.includes(input.orgId)) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Organisation not found" });
    }
    const customer = await findOrCreateBillingCustomer(ctx.db, {
      userId: ctx.userId,
      orgId: input.orgId ?? null,
    });
    const session = await stripeClient().createPortalSession(customer.stripeCustomerId);
    return { url: session.url };
  }),
});

const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  await requireAdmin(liveAdminDeps(), ctx.userId);
  return next({ ctx });
});

export const adminRouter = createTRPCRouter({
  overview: adminProcedure.query(async ({ ctx }) => {
    const { adminOverview } = await import("./admin-overview");
    return adminOverview(ctx.db);
  }),
});
