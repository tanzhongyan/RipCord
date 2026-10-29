import type { Meta, StoryObj } from "@storybook/react";
import { AdminView } from "./admin-view";

const meta: Meta = { title: "Admin" };
export default meta;
type Story = StoryObj;

export const Overview: Story = {
  render: () => (
    <AdminView
      overview={{
        queue: [
          {
            id: "q1",
            providerName: "Demo Telco",
            address: "cancel@demo-telco.example",
            verified: false,
          },
          { id: "q2", providerName: "Fibre Co", address: "help@fibre.example", verified: true },
        ],
        dsrs: [{ id: "d1", kind: "EXPORT", status: "OPEN" }],
        audit: { ok: true, checked: 120, total: 120 },
        spend: { period: "2026-10", rows: [{ ownerKey: "user:alex", costMicros: 1_250_000 }] },
        counts: {
          byStatus: [
            { status: "EXECUTING", count: 3 },
            { status: "SUCCEEDED", count: 9 },
          ],
          byProvider: [
            { providerId: "p1", name: "Demo Telco", count: 8 },
            { providerId: null, name: null, count: 1 },
          ],
        },
      }}
    />
  ),
};

export const Empty: Story = {
  render: () => (
    <AdminView
      overview={{
        queue: [],
        dsrs: [],
        audit: { ok: true, checked: 0, total: 0 },
        spend: { period: "2026-10", rows: [] },
        counts: { byStatus: [], byProvider: [] },
      }}
    />
  ),
};
