import type { Meta, StoryObj } from "@storybook/react";
import { RouteError } from "./route-error";

const meta: Meta<typeof RouteError> = {
  title: "Shared/RouteError",
  component: RouteError,
  args: { reset: () => undefined },
};

export default meta;
type Story = StoryObj<typeof RouteError>;

export const WithReference: Story = {
  args: { error: Object.assign(new Error("hidden"), { digest: "1234567890" }) },
};
export const WithoutReference: Story = { args: { error: new Error("hidden") } };
