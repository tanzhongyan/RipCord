import type { Meta, StoryObj } from "@storybook/react";
import { Inbox } from "lucide-react";
import { EmptyState } from "./empty-state";

const meta: Meta<typeof EmptyState> = {
  title: "Shared/EmptyState",
  component: EmptyState,
  args: {
    icon: Inbox,
    title: "Start your first cancellation",
    body: "Tell us which subscription to cancel. We'll handle the rest and show every step here.",
    cta: { href: "/chat", label: "Start a cancellation" },
  },
};

export default meta;
type Story = StoryObj<typeof EmptyState>;

export const WithAction: Story = {};
export const WithoutAction: Story = { args: { cta: undefined } };
