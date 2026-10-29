import type { Meta, StoryObj } from "@storybook/react";
import { HolderShell } from "~/shared/components/holder-shell";
import type { MandateView } from "../server/mandate-flow";
import { ConsentForm } from "./consent-form";
import { MandateReview } from "./mandate-review";

const meta: Meta = {
  title: "Identity/Holder pages",
  parameters: { layout: "fullscreen", nextjs: { appDirectory: true } },
};
export default meta;
type Story = StoryObj;

const view: MandateView = {
  mandateId: "00000000-0000-4000-8000-000000000001",
  requesterName: "Alex Tan",
  providerName: "Demo Telco",
  serviceType: "Mobile plan",
  accountHint: "5678",
  actions: ["CANCEL_SERVICE", "REQUEST_FINAL_BILL"],
  maxFeeCents: 500,
  expiresAt: new Date("2026-11-30T04:00:00Z"),
  sandbox: false,
  status: "PENDING",
  liveModeApproved: false,
  needsIdentity: false,
};

const review = (v: MandateView) => (
  <HolderShell title="Authorisation request">
    <MandateReview view={v} token="story" />
  </HolderShell>
);

export const Pending: Story = { render: () => review(view) };
export const Active: Story = { render: () => review({ ...view, status: "ACTIVE" }) };
export const Expired: Story = { render: () => review({ ...view, status: "EXPIRED" }) };

/** Clicks "Send code" with the network call stubbed, so the code form shows. */
export const CodeSent: Story = {
  render: () => review(view),
  play: async ({ canvasElement }) => {
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    canvasElement.querySelector<HTMLButtonElement>("button")?.click();
  },
};

/** Same as CodeSent, for a holder with no stored name or NRIC. */
export const NeedsIdentityFields: Story = {
  render: () => review({ ...view, needsIdentity: true }),
  play: CodeSent.play,
};

export const Consent: Story = {
  render: () => (
    <HolderShell title="Connect an assistant">
      <ConsentForm
        clientName="Claude"
        scopes={["openid", "cases:read", "cases:write"]}
        oauthQuery="client_id=x"
      />
    </HolderShell>
  ),
};
