import type { Meta, StoryObj } from "@storybook/react";

import { Message, PromptSuggestions } from "./message";
import { ConfirmCard, ToolCard } from "./tool-card";

const meta: Meta = {
  title: "Chat/Pieces",
  decorators: [
    (Story) => (
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj;

export const Empty: Story = {
  render: () => (
    <PromptSuggestions
      prompts={[
        "Cancel my Singtel fibre plan",
        "Can I leave my gym contract early?",
        "Check my phone bill for charges I do not recognise",
      ]}
      onPick={() => undefined}
    />
  ),
};

export const Streaming: Story = {
  render: () => (
    <>
      <Message from="user" content="Cancel my Singtel fibre plan" />
      <Message
        from="assistant"
        content="Looking up your Singtel contract and the notice"
        streaming
      />
    </>
  ),
};

export const ToolRunning: Story = {
  render: () => <ToolCard line={{ callId: "1", name: "find-provider", status: "running" }} />,
};

export const ToolError: Story = {
  render: () => (
    <>
      <ToolCard line={{ callId: "1", name: "find-provider", status: "ok" }} />
      <ToolCard
        line={{
          callId: "2",
          name: "draft-notice",
          status: "error",
          detail: "No contract end date on file for this case.",
        }}
      />
    </>
  ),
};

export const Confirm: Story = {
  render: () => (
    <ConfirmCard
      busy={false}
      onAnswer={() => undefined}
      card={{
        callId: "3",
        name: "send-notice",
        summary: "Email Singtel to cancel fibre plan 8812 3345 and spend 1 credit.",
        args: {
          provider: "Singtel",
          account: "8812 3345",
          effectiveDate: "2026-12-01",
        },
      }}
    />
  ),
};

export const LongUrlAndCode: Story = {
  render: () => (
    <Message
      from="assistant"
      content={
        "Use the cancellation form at https://www.singtel.com/personal/support/cancel-service/fibre-broadband/request?account=881233456789&reference=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 and quote this reference.\n\n```\nRIPCORD-MANDATE-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ\n```"
      }
    />
  ),
};
