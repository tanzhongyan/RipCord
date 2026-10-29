/**
 * Site config: the single source for metadata, titles and navigation.
 * `make brand-check` verifies the wiring into `src/app/layout.tsx`.
 */

export interface NavLink {
  label: string;
  href: string;
}

export const site = {
  name: "RipCord",
  tagline: "Cancel subscriptions without the phone calls",
  description:
    "RipCord cancels your subscriptions under a mandate you sign, then checks your next bill to confirm the charge stopped.",
  /** Canonical production URL, without a trailing slash. */
  url: "https://ripcord.example",
  locale: "en_SG",
  /** Next.js metadata title template; page titles pass through this. */
  titleTemplate: "%s · RipCord",
  defaultTitle: "RipCord · Cancel subscriptions without the phone calls",
  nav: {
    primary: [
      { label: "How it works", href: "/#how-it-works" },
      { label: "Pricing", href: "/#pricing" },
      { label: "FAQ", href: "/#faq" },
    ] satisfies NavLink[],
  },
  legal: {
    // OWNER-TODO: placeholders until the owner names the company and mailbox.
    company: "RipCord Pte. Ltd.",
    contactEmail: "privacy@ripcord.example",
    supportEmail: "support@ripcord.example",
  },
};

export type Site = typeof site;
