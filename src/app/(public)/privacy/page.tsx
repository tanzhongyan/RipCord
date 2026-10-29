// OWNER-TODO: legal text drafted from the data contract. The owner and a lawyer must review it before launch.
import type { Metadata } from "next";

import { LegalPage, type LegalSection } from "~/shared/components/legal-page";
import { site } from "~/shared/config/site";

export const metadata: Metadata = {
  title: "Privacy",
  description: `How ${site.name} collects, uses, stores and deletes your data.`,
  alternates: { canonical: "/privacy" },
};

const sections: LegalSection[] = [
  {
    heading: "What we use your data for",
    body: [
      "We use your data to cancel the subscriptions you ask us to cancel. That means finding the provider's cancellation channel, contacting the provider under a mandate you sign, and checking your next bill to confirm the charge stopped.",
      "We also use it to run your account, take payment, keep an audit trail, and prevent abuse. We do not sell your data and we do not use it for advertising.",
    ],
  },
  {
    heading: "What we hold",
    body: [
      "Account data: your login email and name. We show it only to you.",
      "Secret personal data: for example your NRIC, full name, date of birth, address, phone number, email, account number or PIN. We keep each value only as ciphertext in an encrypted vault. Everywhere else, including model prompts, transcripts, logs and URLs, we use a placeholder token such as {{vault:NRIC:<id>}} instead of the value.",
      "Case data: the provider, the status of your request, the documents you upload (such as a bill or contract), and the messages we exchange with the provider. Personal details inside them appear as tokens.",
      "Provider data: public facts about companies and how to cancel with them. It holds no personal data.",
    ],
  },
  {
    heading: "When a real value is released",
    body: [
      "We replace a token with the real value only at the moment we send it, and only when your mandate is active, the destination is a verified channel of that provider, and the provider needs that kind of detail. For your NRIC, PIN and account number, you approve the release first. Every release is recorded in an audit log.",
    ],
  },
  {
    heading: "What we never store",
    body: [
      "We never store secret personal data outside the vault. We never store provider login passwords, card numbers (Stripe holds those) or call recordings. We keep personal data out of URLs, query strings and application logs.",
    ],
  },
  {
    heading: "How long we keep it",
    body: [
      "Bills, contracts and screenshots: 30 days after your case closes.",
      "Letters of authority, receipts, dispute packages and the messages we exchanged with the provider: 18 months after your case closes.",
      "Vault secrets: until you delete them, or 90 days after your last case closes.",
      "Call audio: we do not store it. It is streamed to transcription and then discarded.",
      "Audit logs: 5 years.",
      "Provider data and channel statistics: indefinitely. They hold no personal data.",
      "A daily job enforces these periods and records each deletion in the audit log.",
    ],
  },
  {
    heading: "Who processes data for us",
    body: [
      "Stripe takes payment. We do not see your card number.",
      "Twilio sends one-time codes by SMS and places calls to providers.",
      "An AI model provider (Meta, through an OpenAI-compatible API) runs the assistant. It receives placeholder tokens, not secret values.",
      "An S3-compatible object store holds the documents you upload.",
      "An email service delivers our messages to you and to providers.",
      // OWNER-TODO: confirm hosting provider, regions and transfer terms for each processor.
    ],
  },
  {
    heading: "Your choices",
    body: [
      `You can delete your vault secrets at any time. To access, correct or delete other data, or to ask a question, write to ${site.legal.contactEmail}.`,
    ],
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      intro={`${site.legal.company} runs ${site.name}.`}
      sections={sections}
    />
  );
}
