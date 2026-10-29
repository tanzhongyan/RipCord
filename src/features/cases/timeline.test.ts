import { describe, expect, it } from "vitest";

import { timelineSentence } from "./timeline";

describe("timelineSentence", () => {
  it("names the user as you and the holder by their alias", () => {
    expect(timelineSentence({ action: "CASE_CREATED", actorType: "USER" })).toBe(
      "You opened this case",
    );
    expect(timelineSentence({ action: "MANDATE_SIGNED", actorType: "HOLDER" }, "Mum")).toBe(
      "Mum signed the mandate",
    );
    expect(timelineSentence({ action: "CASE_TRANSITION", actorType: "SYSTEM" })).toBe(
      "We moved the case to a new stage",
    );
  });

  it("falls back to a plain holder name and a humanised action", () => {
    expect(timelineSentence({ action: "MANDATE_REVOKED", actorType: "HOLDER" })).toBe(
      "The account holder withdrew the mandate",
    );
    expect(timelineSentence({ action: "RETENTION_PURGE", actorType: "SYSTEM" })).toBe(
      "Retention purge",
    );
  });
});
