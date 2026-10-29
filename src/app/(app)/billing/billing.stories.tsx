import type { Meta, StoryObj } from "@storybook/react";
import { PageSkeleton } from "~/shared/components/page-skeleton";
import { BillingView } from "./billing-view";

const row = (n: number, delta: number, reason: string) => ({
  id: `row-${n}`,
  delta,
  reason,
  createdAt: new Date(`2026-10-0${n}T04:00:00Z`),
  stripeRef: null,
});

const meta: Meta = { title: "Billing" };
export default meta;
type Story = StoryObj;

const base = { orgs: [], priceDisplay: "S$1.99" };

export const Ready: Story = {
  render: () => (
    <BillingView
      {...base}
      balance={{ balance: 3, plan: "INDIVIDUAL" }}
      ledger={{
        rows: [row(1, 5, "PURCHASE"), row(2, -1, "CONSUME"), row(3, 1, "REFUND")],
        page: 1,
        pageSize: 50,
        total: 3,
      }}
    />
  ),
};

export const Loading: Story = { render: () => <PageSkeleton rows={3} /> };

export const EmptyHistory: Story = {
  render: () => (
    <BillingView
      {...base}
      balance={{ balance: 0, plan: "INDIVIDUAL" }}
      ledger={{ rows: [], page: 1, pageSize: 50, total: 0 }}
    />
  ),
};
