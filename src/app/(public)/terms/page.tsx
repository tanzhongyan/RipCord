// OWNER-TODO: legal text drafted from the data contract. The owner and a lawyer must review it before launch.
import type { Metadata } from "next";

import { LegalPage, type LegalSection } from "~/shared/components/legal-page";
import { env } from "~/shared/config/env";
import { site } from "~/shared/config/site";

export const metadata: Metadata = {
  title: "Terms",
  description: `The terms for using ${site.name}.`,
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  const sections: LegalSection[] = [
    {
      heading: "What the service does",
      body: [
        `${site.name} helps you cancel a subscription. You tell us which provider and service. We find the provider's cancellation channels, contact the provider under a mandate you sign, keep a receipt, and check your next bill to confirm the charge stopped.`,
      ],
    },
    {
      heading: "What the agent does not do",
      body: [
        "We do not guarantee that a provider will accept a cancellation. We do not give legal, financial or tax advice. We do not act without a signed mandate, and we act only for the provider and service named in it.",
        "We do not store your provider passwords. If a cancellation needs you to log in or confirm something, we tell you what to do next.",
      ],
    },
    {
      heading: "Mandates",
      body: [
        "A mandate is your written permission for us to act for you with one provider. You sign it, and you can withdraw it at any time. It expires on the date it states. We can release your personal details to the provider only while the mandate is active.",
      ],
    },
    {
      heading: "Credits and price",
      body: [
        `One cancellation request costs one credit. A credit costs ${env.PRICE_CREDIT_DISPLAY}. You pay per request, not per result, so the price does not depend on the outcome.`,
        "A request covers one provider and one service until the case closes. It includes all channels, retries, the receipt, verification and one dispute package. Searching for a provider and browsing our knowledge base are free.",
        "We take the credit when your request moves from draft to discovery. Organisation plans and extra credits are priced on the home page. Stripe handles payment.",
      ],
    },
    {
      heading: "Refunds",
      body: ["Our refund rule is on the refund page. It applies automatically."],
    },
    {
      heading: "Your responsibilities",
      body: [
        "Give us accurate details and only cancel services you are entitled to cancel. Do not use the service to act for someone else without their permission, or to send abusive or repeated requests. We limit how many cases, messages and calls you can start each day.",
      ],
    },
    {
      heading: "Changes and contact",
      body: [
        `We may change these terms and will post the new version here. Questions go to ${site.legal.supportEmail}.`,
        "OWNER-TODO: add governing law, liability cap and dispute terms.",
      ],
    },
  ];

  return (
    <LegalPage
      title="Terms"
      intro={`${site.legal.company} runs ${site.name}.`}
      sections={sections}
    />
  );
}
