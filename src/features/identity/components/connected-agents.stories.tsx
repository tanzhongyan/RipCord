import type { Meta, StoryObj } from "@storybook/react";
import { MockAppProviders } from "../../../../.storybook/mock-providers";
import { ConnectedAgentsList } from "./connected-agents";

const meta: Meta = { title: "Settings/Connected agents" };
export default meta;
type Story = StoryObj;

export const Empty: Story = {
  render: () => (
    <MockAppProviders mocks={{ "agents.list": [] }}>
      <ConnectedAgentsList />
    </MockAppProviders>
  ),
};

export const TwoAgents: Story = {
  render: () => (
    <MockAppProviders
      mocks={{
        "agents.list": [
          {
            clientId: "a1",
            name: "Claude",
            createdAt: new Date("2026-09-01T00:00:00Z"),
            lastUsedAt: new Date("2026-10-05T00:00:00Z"),
          },
          {
            clientId: "a2",
            name: null,
            createdAt: new Date("2026-10-01T00:00:00Z"),
            lastUsedAt: null,
          },
        ],
      }}
    >
      <ConnectedAgentsList />
    </MockAppProviders>
  ),
};
