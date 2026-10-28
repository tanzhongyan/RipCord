import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { buildLoaLines, renderLoaPdf } from "./loa";

const INPUT = {
  signedDate: "28 October 2026",
  providerName: "Test Provider",
  delegateName: "Alice",
  serviceType: "MOBILE_POSTPAID",
  fullNameToken: "{{vault:FULL_NAME:11111111-1111-1111-1111-111111111111}}",
  nricToken: "{{vault:NRIC:22222222-2222-2222-2222-222222222222}}",
  accountToken: "{{vault:ACCOUNT_NO:33333333-3333-3333-3333-333333333333}}",
  actions: ["CANCEL_SERVICE", "REQUEST_FINAL_BILL", "ARRANGE_EQUIPMENT_RETURN"] as const,
  expiresDate: "27 November 2026",
  typedName: "Dad",
  signedAt: "28 October 2026, 10:00",
  mandateId: "44444444-4444-4444-4444-444444444444",
};

describe("letter of authorisation", () => {
  it("lays out content in the spec order with exact labels", () => {
    expect(buildLoaLines({ ...INPUT, actions: [...INPUT.actions] })).toEqual([
      "Letter of Authorisation",
      "28 October 2026",
      "To: Test Provider",
      "I, {{vault:FULL_NAME:11111111-1111-1111-1111-111111111111}}, holder of identification {{vault:NRIC:22222222-2222-2222-2222-222222222222}}, authorise Alice to act on my behalf for the following account only: {{vault:ACCOUNT_NO:33333333-3333-3333-3333-333333333333}}, service type MOBILE_POSTPAID.",
      "- Terminate the service",
      "- Request the final bill",
      "- Arrange return of equipment",
      "This authorisation does not permit opening, upgrading or changing any other service. It expires on 27 November 2026.",
      "Dad",
      "Signed electronically",
      "28 October 2026, 10:00",
      "Mandate reference: 44444444-4444-4444-4444-444444444444",
    ]);
  });

  it("renders a loadable A4 PDF", async () => {
    const pdf = await renderLoaPdf(buildLoaLines({ ...INPUT, actions: [...INPUT.actions] }), "Dad");
    expect(pdf.subarray(0, 4)).toEqual(new TextEncoder().encode("%PDF"));
    const loaded = await PDFDocument.load(pdf);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
    const [page] = loaded.getPages();
    expect(page?.getSize().width).toBeCloseTo(595.28, 1);
  });
});
