// OWNER-TODO: legal text drafted from the data contract. The owner and a lawyer must review it before launch.
import type { Metadata } from "next";

import { LegalPage, type LegalSection } from "~/shared/components/legal-page";
import { env } from "~/shared/config/env";
import { site } from "~/shared/config/site";

export const metadata: Metadata = {
  title: "Refunds",
  description: `When ${site.name} refunds a credit.`,
  alternates: { canonical: "/refund" },
};

export default function RefundPage() {
  const sections: LegalSection[] = [
    {
      heading: "When we refund",
      body: [
        `A credit costs ${env.PRICE_CREDIT_DISPLAY}. We refund it automatically, and only, when your case closes for one of three reasons.`,
        "Provider unsupported: we cannot cancel with this provider.",
        "No viable channel: we found no working way to reach the provider.",
        "Internal error: something failed on our side.",
      ],
    },
    {
      heading: "How refunds work",
      body: [
        "A refund depends only on what happened to your case, never on a claim from you. You do not need to ask. The credit goes back to your balance.",
      ],
    },
    {
      heading: "When we do not refund",
      body: [
        "You pay per request, not per result. If we sent the cancellation and the provider refused it, or kept charging you, we do not refund the credit. The request still covers a receipt, verification and one dispute package.",
      ],
    },
    {
      heading: "Questions",
      body: [`Write to ${site.legal.supportEmail} and we will look at your case.`],
    },
  ];

  return (
    <LegalPage
      title="Refunds"
      intro={`${site.legal.company} runs ${site.name}.`}
      sections={sections}
    />
  );
}
