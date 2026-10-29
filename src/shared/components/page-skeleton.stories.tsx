import type { Meta, StoryObj } from "@storybook/react";
import { PageSkeleton } from "./page-skeleton";

const meta: Meta<typeof PageSkeleton> = {
  title: "Shared/PageSkeleton",
  component: PageSkeleton,
};

export default meta;
type Story = StoryObj<typeof PageSkeleton>;

export const Default: Story = {};
export const SixRows: Story = { args: { rows: 6 } };
