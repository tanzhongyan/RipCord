import { describe, expect, it } from "vitest";

import { type ModelExtraction, modelExtractionSchema } from "./model";
import { filterExtractionByQuotes } from "./quotes";

const PAGE_TEXT =
  "To cancel your mobile plan, email cancel@example.com at least 30 days out. " +
  "Early termination fees apply within the minimum term of 24 months.";

function extraction(): ModelExtraction {
  return modelExtractionSchema.parse({
    channels: [
      {
        kind: "EMAIL",
        address: "cancel@example.com",
        acceptsLoa: "YES",
        requiredSecrets: ["FULL_NAME", "NRIC", "ACCOUNT_NO"],
        noticeDays: 30,
        confidence: 80,
        quote: "email cancel@example.com at least 30 days out",
      },
      {
        kind: "PHONE_IVR",
        address: "+15005550006",
        acceptsLoa: "UNKNOWN",
        confidence: 60,
        quote: "call our hotline at midnight",
      },
      {
        kind: "WEB_FORM",
        address: "https://example.com/quoteless",
        acceptsLoa: "UNKNOWN",
        confidence: 60,
        quote: "",
      },
    ],
    policies: [
      {
        kind: "MIN_TERM",
        rule: { months: 24 },
        excerpt: "Minimum term is 24 months.",
        confidence: 70,
        quote: "minimum term of 24 months",
      },
    ],
  });
}

describe("filterExtractionByQuotes", () => {
  it("keeps fields quoted verbatim and drops the rest", () => {
    const { extraction: checked, dropped } = filterExtractionByQuotes(extraction(), PAGE_TEXT);
    expect(checked.channels.map((channel) => channel.address)).toEqual(["cancel@example.com"]);
    expect(checked.policies.map((policy) => policy.kind)).toEqual(["MIN_TERM"]);
    expect(dropped.sort()).toEqual([
      "channel:+15005550006",
      "channel:https://example.com/quoteless",
    ]);
  });

  it("tolerates line-break whitespace inside quotes", () => {
    const { extraction: checked } = filterExtractionByQuotes(
      extraction(),
      PAGE_TEXT.replace("cancel@example.com at", "cancel@example.com\nat"),
    );
    expect(checked.channels.map((channel) => channel.address)).toEqual(["cancel@example.com"]);
  });
});
