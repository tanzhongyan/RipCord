import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CaseProgress } from "./case-progress";

const render = (status: string, failureReason?: string) =>
  renderToStaticMarkup(<CaseProgress status={status} failureReason={failureReason} />);

/** DESIGN.md signature element: the rope snaps at SUCCEEDED and DISPUTED only. */
describe("CaseProgress", () => {
  it("snaps with the coral cut tips when the case succeeded", () => {
    const html = render("SUCCEEDED");
    expect(html).toContain("text-cut");
    expect(html).not.toContain("billed again");
  });

  it("snaps and warns when the provider billed again", () => {
    const html = render("DISPUTED");
    expect(html).toContain("text-cut");
    expect(html).toContain("Your provider billed again");
  });

  it("keeps an unbroken muted line and explains a failure in plain words", () => {
    const html = render("FAILED", "PROVIDER_REFUSED");
    expect(html).not.toContain("text-cut");
    expect(html).toContain("The provider refused the request.");
    expect(html).not.toContain("PROVIDER_REFUSED");
  });

  it("keeps an unbroken line for a withdrawn case and for one still running", () => {
    expect(render("WITHDRAWN")).not.toContain("text-cut");
    const running = render("EXECUTING");
    expect(running).not.toContain("text-cut");
    expect(running).toContain('aria-current="step"');
  });
});
