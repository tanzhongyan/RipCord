import type { Meta, StoryObj } from "@storybook/react";
import { PageSkeleton } from "~/shared/components/page-skeleton";
import { RouteError } from "~/shared/components/route-error";
import { CaseList, type DashboardCaseRow } from "./case-list";
import { StatCards } from "./stat-cards";

const row = (n: number, status: string, providerName: string | null): DashboardCaseRow => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  status,
  providerId: null,
  providerName,
  holderId: "00000000-0000-4000-8000-0000000000aa",
  holderAlias: n % 2 ? "Mum" : "Me",
  updatedAt: new Date(`2026-10-0${n}T04:00:00Z`),
  createdAt: new Date("2026-09-01T00:00:00Z"),
});

const cases = [
  row(1, "SUCCEEDED", "Singtel"),
  row(2, "EXECUTING", "StarHub"),
  row(3, "AWAITING_MANDATE", "M1"),
  row(4, "FAILED", null),
];

const meta: Meta = { title: "Dashboard" };
export default meta;
type Story = StoryObj;

export const Ready: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <StatCards
        openCases={2}
        balance={3}
        plan="INDIVIDUAL"
        lastOutcome={{ status: "SUCCEEDED", providerName: "Singtel", at: new Date("2026-10-01") }}
      />
      <CaseList cases={cases} total={4} nextCursor={null} />
    </div>
  ),
};

export const Loading: Story = { render: () => <PageSkeleton rows={4} /> };

export const Empty: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <StatCards openCases={0} balance={0} plan="INDIVIDUAL" lastOutcome={null} />
      <CaseList cases={[]} total={0} nextCursor={null} />
    </div>
  ),
};

export const FilteredEmpty: Story = {
  render: () => <CaseList cases={[]} total={0} nextCursor={null} status="FAILED" />,
};

export const ErrorState: Story = {
  render: () => <RouteError error={new Error("hidden")} reset={() => undefined} />,
};
