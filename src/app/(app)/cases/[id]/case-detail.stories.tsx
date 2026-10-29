import type { Meta, StoryObj } from "@storybook/react";
import { PageSkeleton } from "~/shared/components/page-skeleton";
import { CaseDetail } from "./case-detail";

const id = "5c1f3a52-8d0e-4a3b-9d2c-0f6a7b1e2c34";
const day = (d: number) => new Date(`2026-10-${String(d).padStart(2, "0")}T04:00:00Z`);

const base = {
  steps: [],
  terms: null,
  receipt: null,
};

const timeline = [
  { id: 1, action: "case.created", actorType: "USER", actorId: "you", createdAt: day(1) },
  { id: 2, action: "case.mandate_signed", actorType: "HOLDER", actorId: "Mum", createdAt: day(3) },
];

function story(
  status: string,
  extra: { failureReason?: string | null; closed?: boolean; receipt?: boolean } = {},
) {
  return (
    <CaseDetail
      view={{
        ...base,
        receipt: extra.receipt ? { referenceCode: "SG-48213", effectiveDate: "2026-10-12" } : null,
        case: {
          id,
          status,
          serviceType: "Mobile plan",
          recommendation: null,
          failureReason: extra.failureReason ?? null,
          createdAt: day(1),
          updatedAt: day(9),
          closedAt: extra.closed ? day(9) : null,
        },
      }}
      timeline={timeline}
      documents={[]}
      verification={null}
      providerName="Singtel"
    />
  );
}

const meta: Meta = { title: "Case page", parameters: { nextjs: { appDirectory: true } } };
export default meta;
type Story = StoryObj;

export const Executing: Story = { render: () => story("EXECUTING") };
export const Succeeded: Story = {
  render: () => story("SUCCEEDED", { closed: true, receipt: true }),
};
export const Failed: Story = {
  render: () => story("FAILED", { failureReason: "PROVIDER_REFUSED", closed: true }),
};
export const Withdrawn: Story = { render: () => story("WITHDRAWN", { closed: true }) };
export const Disputed: Story = {
  render: () => story("DISPUTED", { closed: true, receipt: true }),
};
export const Loading: Story = { render: () => <PageSkeleton rows={3} /> };
