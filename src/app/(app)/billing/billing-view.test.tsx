import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={typeof href === "string" ? href : "#"} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("~/trpc/react", () => ({
  api: {
    billing: {
      checkout: { useMutation: () => ({ mutate: () => undefined }) },
      portal: { useMutation: () => ({ mutate: () => undefined }) },
      subscribe: { useMutation: () => ({ mutate: () => undefined }) },
    },
  },
}));

import { BillingView } from "./billing-view";

const ledgerRow = {
  id: "row-1",
  delta: 5,
  reason: "PURCHASE",
  createdAt: new Date("2026-10-01T00:00:00Z"),
  stripeRef: "cs_test",
};

/** F5: org owners see a Subscribe button wired to billing.subscribe. */
describe("F5 Subscribe button", () => {
  it("renders Subscribe for owner orgs only", () => {
    const props = {
      balance: { balance: 3, plan: "INDIVIDUAL" },
      ledger: { rows: [ledgerRow], page: 1, pageSize: 50, total: 1 },
      priceDisplay: "S$1.99",
    };
    const ownerHtml = renderToStaticMarkup(
      <BillingView {...props} orgs={[{ orgId: "org-1", role: "owner" }]} />,
    );
    expect(ownerHtml).toContain("Subscribe org");
    const memberHtml = renderToStaticMarkup(
      <BillingView {...props} orgs={[{ orgId: "org-1", role: "member" }]} />,
    );
    expect(memberHtml).not.toContain("Subscribe org");
  });
});

/** F6: the ledger pages through page/pageSize/total. */
describe("F6 Ledger pagination", () => {
  it("renders prev/next links from the ledger page", () => {
    const props = {
      balance: { balance: 3, plan: "INDIVIDUAL" },
      orgs: [],
      priceDisplay: "S$1.99",
    };
    const middle = renderToStaticMarkup(
      <BillingView {...props} ledger={{ rows: [ledgerRow], page: 2, pageSize: 50, total: 125 }} />,
    );
    expect(middle).toContain("?page=1");
    expect(middle).toContain("?page=3");
    const first = renderToStaticMarkup(
      <BillingView {...props} ledger={{ rows: [ledgerRow], page: 1, pageSize: 50, total: 125 }} />,
    );
    expect(first).not.toContain("Previous");
    expect(first).toContain("?page=2");
    const last = renderToStaticMarkup(
      <BillingView {...props} ledger={{ rows: [ledgerRow], page: 3, pageSize: 50, total: 125 }} />,
    );
    expect(last).toContain("?page=2");
    expect(last).not.toContain(">Next</a>");
  });
});
