import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminView } from "./admin-view";

/** F7: the admin page renders the per-provider case breakdown. */
describe("F7 Cases by provider", () => {
  it("renders provider names with counts", () => {
    const html = renderToStaticMarkup(
      <AdminView
        overview={{
          queue: [],
          dsrs: [],
          audit: { ok: true, checked: 10, total: 10 },
          spend: { period: "2026-10", rows: [] },
          counts: {
            byStatus: [{ status: "DISCOVERY", count: 2 }],
            byProvider: [
              { providerId: "provider-1", name: "Demo Telco", count: 2 },
              { providerId: null, name: null, count: 1 },
            ],
          },
        }}
      />,
    );
    expect(html).toContain("Cases by provider");
    expect(html).toContain("Demo Telco");
    expect(html).toContain("Unknown provider");
  });
});
