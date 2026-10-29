import { describe, expect, it } from "vitest";
import { checkContrastPairs, contrastRatio } from "./tokens";

describe("brand tokens", () => {
  it("rates black on white near the 21:1 maximum", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeGreaterThan(20);
  });

  it("passes every pair at its WCAG minimum in both themes", () => {
    const failures = checkContrastPairs().filter((r) => !r.pass);
    expect(failures).toEqual([]);
  });
});
