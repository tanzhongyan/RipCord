import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={typeof href === "string" ? href : "#"} className={className}>
      {children}
    </a>
  ),
}));

import { CaseList } from "./case-list";

/** F1: dashboard rows show the holder alias and provider name. */
describe("F1 CaseList rows", () => {
  it("renders alias and provider instead of id slices", () => {
    const html = renderToStaticMarkup(
      <CaseList
        cases={[
          {
            id: "11111111-2222-3333-4444-555555555555",
            status: "DISCOVERY",
            providerId: "provider-1",
            providerName: "Demo Telco",
            holderId: "66666666-7777-8888-9999-000000000000",
            holderAlias: "F1 Holder",
            updatedAt: new Date("2026-10-01T00:00:00Z"),
            createdAt: new Date("2026-09-01T00:00:00Z"),
          },
        ]}
        total={1}
        nextCursor={null}
      />,
    );
    expect(html).toContain(">F1 Holder</a>");
    expect(html).toContain("Demo Telco");
    expect(html).not.toContain(">11111111</a>");
    expect(html).not.toContain("66666666");
  });
});
