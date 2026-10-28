import { randomUUID } from "node:crypto";

import Stripe from "stripe";

import { env } from "~/shared/config/env";

export interface StripeCheckoutInput {
  priceId: string;
  quantity: number;
  customerId: string;
  mode: "payment" | "subscription";
  metadata: Record<string, string>;
}

export interface StripeClient {
  createCustomer(metadata: Record<string, string>): Promise<{ id: string }>;
  createCheckoutSession(input: StripeCheckoutInput): Promise<{ id: string; url: string }>;
  createPortalSession(customerId: string): Promise<{ url: string }>;
  constructEvent(payload: string, signature: string): unknown;
}

class LiveStripeClient implements StripeClient {
  private readonly stripe: Stripe;

  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey);
  }

  async createCustomer(metadata: Record<string, string>): Promise<{ id: string }> {
    const customer = await this.stripe.customers.create({ metadata });
    return { id: customer.id };
  }

  async createCheckoutSession(input: StripeCheckoutInput): Promise<{ id: string; url: string }> {
    const session = await this.stripe.checkout.sessions.create({
      mode: input.mode,
      customer: input.customerId,
      line_items: [{ price: input.priceId, quantity: input.quantity }],
      success_url: `${env.APP_URL}/billing?success=true`,
      cancel_url: `${env.APP_URL}/billing?cancelled=true`,
      metadata: input.metadata,
    });
    if (!session.url) throw new Error("Stripe returned no checkout URL");
    return { id: session.id, url: session.url };
  }

  async createPortalSession(customerId: string): Promise<{ url: string }> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${env.APP_URL}/billing`,
    });
    return { url: session.url };
  }

  constructEvent(payload: string, signature: string): unknown {
    const secret = env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
    return this.stripe.webhooks.constructEvent(payload, signature, secret);
  }
}

/** In-memory Stripe double for tests. */
export class FakeStripeClient implements StripeClient {
  readonly customers: Array<{ id: string; metadata: Record<string, string> }> = [];
  readonly sessions: Array<StripeCheckoutInput & { id: string; url: string }> = [];
  readonly portals: Array<{ customerId: string; url: string }> = [];
  private counter = 0;
  /** Test-only latency injected before createCustomer resolves, to force races. */
  delayMs = 0;

  async createCustomer(metadata: Record<string, string>): Promise<{ id: string }> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    this.counter += 1;
    const id = `cus_fake_${this.counter}_${randomUUID()}`;
    this.customers.push({ id, metadata });
    return { id };
  }

  async createCheckoutSession(input: StripeCheckoutInput): Promise<{ id: string; url: string }> {
    this.counter += 1;
    const id = `cs_fake_${this.counter}`;
    const url = `https://checkout.stripe.test/${id}`;
    this.sessions.push({ ...input, id, url });
    return { id, url };
  }

  async createPortalSession(customerId: string): Promise<{ url: string }> {
    const url = `https://billing.stripe.test/portal/${customerId}`;
    this.portals.push({ customerId, url });
    return { url };
  }

  constructEvent(payload: string, signature: string): unknown {
    if (signature !== "valid-test-signature") {
      const error = new Error("Invalid signature") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    return JSON.parse(payload) as unknown;
  }
}

let override: StripeClient | null = null;

/** Test seam: substitute a fake Stripe client. Pass null to restore live. */
export function setStripeOverride(client: StripeClient | null): void {
  override = client;
}

/** True when a live secret or a test double can serve Stripe calls. */
export function isStripeConfigured(): boolean {
  return override !== null || !!env.STRIPE_SECRET_KEY;
}

export function stripeClient(): StripeClient {
  if (override) return override;
  const secret = env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("STRIPE_SECRET_KEY is not configured");
  return new LiveStripeClient(secret);
}
