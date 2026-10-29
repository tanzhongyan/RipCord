/** Landing copy. Voice rules are in DESIGN.md; every claim maps to specs 0000-0007. */

export interface Prices {
  /** Per request, from `PRICE_CREDIT_DISPLAY`. */
  credit: string;
  /** Org plan per month, from `PRICE_ORG_MONTHLY_DISPLAY`. */
  orgMonthly: string;
  /** Extra credit on the org plan, from `PRICE_CREDIT_ORG_DISPLAY`. */
  orgExtraCredit: string;
}

export const hero = {
  title: "Cancel a subscription without the phone call.",
  subline:
    "Tell us the service. Sign a mandate that lets us act for you. We contact the provider, then check your next bill to confirm the charge stopped.",
  primaryCta: "Start a cancellation",
  secondaryCta: "How it works",
};

/** Hero preview card: the case page's progress line for a finished case. */
export const heroPreview = {
  title: "Your case page",
  body: "Every step in order. The line snaps once your next bill shows the charge stopped.",
};

export const steps = [
  {
    title: "Tell us the service",
    body: "Name the provider and the plan in chat. We look up how that provider takes cancellations and show you the cost before anything starts.",
  },
  {
    title: "Sign a mandate",
    body: "The account holder gets a 6-digit code by SMS and signs with their name. The mandate lists the provider and the actions we may take, and nothing else.",
  },
  {
    title: "We cancel and check the bill",
    body: "We send the notice or place the call, keep the provider's receipt, and check your next bill. If the provider bills again, you get a dispute package.",
  },
];

export const willDo = [
  "Act only under a mandate the account holder signed.",
  "Cancel one provider and one service per request.",
  "Contact the provider by email or phone, at its verified contact details.",
  "Keep the receipt and check your next bill.",
  "Refund the credit when we can't reach the provider.",
];

export const wontDo = [
  "Open, upgrade or change any other service.",
  "Choose a sales or upgrade option on a provider's phone menu.",
  "Store your card number. Stripe holds it.",
  "Promise that every provider will agree to a cancellation.",
  "Keep acting after you or the holder revoke the mandate.",
];

export const consent = [
  {
    title: "A mandate with limits",
    body: "It names the provider, the service and the actions allowed. It expires 30 days after signing, or 7 days after we send it if nobody signs.",
  },
  {
    title: "A one-time code",
    body: "The holder confirms with a 6-digit code sent by SMS. It expires after 10 minutes and locks after 5 wrong tries.",
  },
  {
    title: "Revoke at any time",
    body: "The SMS link stays open and has a Revoke button. We stop before our next step.",
  },
  {
    title: "Vault tokens",
    body: "Your NRIC, account number and other secrets are stored encrypted. The assistant and our logs only see placeholders, never the real values.",
  },
];

export const refundRule =
  "We refund the credit automatically when the provider isn't supported, when we find no usable way to contact it, or when we hit an internal error. We don't refund when the provider refuses, or when the mandate expires or is revoked.";

export const finalCta = {
  title: "One request, one provider, one clear price.",
  body: "Start with the service you want gone. You see the cost before we begin.",
};

export function planCopy(prices: Prices) {
  return {
    request: {
      name: "Per request",
      price: prices.credit,
      unit: "per request",
      points: [
        "One credit cancels one provider and one service.",
        "Covers every channel, retries, the receipt, the bill check and one dispute package.",
        "Charged when the case starts. Searching providers is free.",
      ],
    },
    org: {
      name: "Team plan",
      price: prices.orgMonthly,
      unit: "per month",
      points: [
        "20 credits each month, for a household or a team.",
        `Extra credits cost ${prices.orgExtraCredit} each.`,
        "Credits expire at renewal.",
      ],
    },
  };
}

export function faqItems(prices: Prices) {
  return [
    {
      question: "How much does it cost?",
      answer: `${prices.credit} per cancellation request. A request covers one provider and one service until the case closes. The team plan is ${prices.orgMonthly} a month for 20 credits, then ${prices.orgExtraCredit} for each extra credit.`,
    },
    {
      question: "What does the account holder have to do?",
      answer:
        'Open the SMS link, enter a 6-digit code, type their name and tap "I authorise". That signs the mandate. The holder doesn\'t need a RipCord account.',
    },
    {
      question: "Can I cancel for a parent?",
      answer:
        "Yes. Add them as a holder and we text them the link. If they haven't signed after 7 days, the case closes as expired and you can start again.",
    },
    {
      question: "How do you contact the provider?",
      answer:
        "By email or by phone, using the provider's verified contact details and only the actions the mandate allows. On a phone menu we never pick a sales or upgrade option.",
    },
    {
      question: "What happens to my NRIC and account number?",
      answer:
        "They're stored encrypted in a vault. The assistant, the logs and the transcripts only see placeholders. A real value leaves the vault only when we send to a verified provider contact, and for NRIC, PIN and account number only after the holder approves.",
    },
    {
      question: "How do you know the cancellation worked?",
      answer:
        "We keep the provider's receipt, then check your next bill about 37 days after the effective date. If the provider bills again, the case is marked disputed and you can download a package to send to your bank or the provider.",
    },
    {
      question: "When do I get a refund?",
      answer: refundRule,
    },
    {
      question: "Can I stop a cancellation?",
      answer:
        "Yes. The holder can revoke from the SMS link at any time. The case then closes with the reason shown, and we stop before our next step. A revoked mandate isn't refunded.",
    },
  ];
}
