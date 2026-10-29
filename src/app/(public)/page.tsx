import { Check, Minus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { BrandMark } from "~/shared/components/brand-mark";
import { RopeDivider } from "~/shared/components/rope-divider";
import { buttonVariants } from "~/shared/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/shared/components/ui/card";
import { env } from "~/shared/config/env";
import { site } from "~/shared/config/site";
import {
  consent,
  faqItems,
  finalCta,
  hero,
  planCopy,
  refundRule,
  steps,
  willDo,
  wontDo,
} from "./landing-content";

export const metadata: Metadata = {
  title: { absolute: site.defaultTitle },
  description: site.description,
  alternates: { canonical: "/" },
};

const prices = {
  credit: env.PRICE_CREDIT_DISPLAY,
  orgMonthly: env.PRICE_ORG_MONTHLY_DISPLAY,
  orgExtraCredit: env.PRICE_CREDIT_ORG_DISPLAY,
};

const faq = faqItems(prices);
const plans = planCopy(prices);

const jsonLd = [
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: site.name,
    url: site.url,
    logo: `${site.url}/mark.svg`,
    description: site.description,
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer support",
      email: site.legal.supportEmail,
    },
  },
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  },
];

const section = "scroll-mt-4 py-8 md:py-12";
const h2 = "text-2xl font-medium leading-[1.15] tracking-tight";
const cta = `${buttonVariants({ size: "lg" })} h-11 px-5 text-base`;
const ctaSecondary = `${buttonVariants({ variant: "outline", size: "lg" })} h-11 px-5 text-base`;

export default function Home() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4">
      {jsonLd.map((block) => (
        <script
          key={block["@type"]}
          type="application/ld+json"
          // Escape "<" so FAQ text can never close the script tag.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static content, "<" escaped
          dangerouslySetInnerHTML={{ __html: JSON.stringify(block).replaceAll("<", "\\u003c") }}
        />
      ))}

      <section className="py-12 md:py-20">
        <BrandMark className="h-8 text-foreground md:h-10" />
        <h1 className="mt-6 max-w-[20ch] text-4xl font-semibold leading-[1.15] tracking-tight md:text-5xl">
          {hero.title}
        </h1>
        <p className="mt-5 max-w-[56ch] text-base leading-relaxed text-muted-foreground md:text-lg">
          {hero.subline}
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link href="/sign-in" className={cta}>
            {hero.primaryCta}
          </Link>
          <Link href="#how-it-works" className={ctaSecondary}>
            {hero.secondaryCta}
          </Link>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          From <span className="font-mono">{prices.credit}</span> per request. Refunded when we
          can&apos;t reach the provider.
        </p>
      </section>

      <RopeDivider />

      <section id="how-it-works" className={section} aria-labelledby="how-heading">
        <h2 id="how-heading" className={h2}>
          How it works
        </h2>
        <ol className="mt-8 grid gap-8 md:grid-cols-3 md:gap-10">
          {steps.map((step, i) => (
            <li key={step.title} className="border-t pt-4">
              <span className="font-mono text-sm text-muted-foreground">0{i + 1}</span>
              <h3 className="mt-2 text-xl font-medium leading-[1.15]">{step.title}</h3>
              <p className="mt-2 leading-relaxed text-muted-foreground">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className={section} aria-labelledby="scope-heading">
        <h2 id="scope-heading" className={h2}>
          What RipCord will and won&apos;t do
        </h2>
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-xl font-medium">We will</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                {willDo.map((item) => (
                  <li key={item} className="flex gap-3">
                    <Check className="mt-1 size-4 shrink-0 text-foreground" strokeWidth={1.75} />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-xl font-medium">We won&apos;t</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                {wontDo.map((item) => (
                  <li key={item} className="flex gap-3">
                    <Minus
                      className="mt-1 size-4 shrink-0 text-muted-foreground"
                      strokeWidth={1.75}
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </section>

      <RopeDivider />

      <section className={section} aria-labelledby="consent-heading">
        <h2 id="consent-heading" className={h2}>
          Consent and security
        </h2>
        <dl className="mt-8 grid gap-x-10 gap-y-6 md:grid-cols-2">
          {consent.map((item) => (
            <div key={item.title} className="border-t pt-4">
              <dt className="text-xl font-medium leading-[1.15]">{item.title}</dt>
              <dd className="mt-2 leading-relaxed text-muted-foreground">{item.body}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-6">
          Read how we handle your data in the{" "}
          <Link href="/privacy" className="underline underline-offset-4">
            privacy policy
          </Link>
          .
        </p>
      </section>

      <section id="pricing" className={section} aria-labelledby="pricing-heading">
        <h2 id="pricing-heading" className={h2}>
          Pricing
        </h2>
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {[plans.request, plans.org].map((plan) => (
            <Card key={plan.name}>
              <CardHeader>
                <CardTitle className="text-xl font-medium">{plan.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <p>
                  <span className="font-mono text-4xl font-medium tracking-tight">
                    {plan.price}
                  </span>{" "}
                  <span className="text-muted-foreground">{plan.unit}</span>
                </p>
                <ul className="mt-4 space-y-2 text-muted-foreground">
                  {plan.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="mt-6 max-w-[70ch] leading-relaxed">
          <strong className="font-medium">Refund rule.</strong> {refundRule}{" "}
          <Link href="/refund" className="underline underline-offset-4">
            Read the refund policy
          </Link>
          .
        </p>
      </section>

      <RopeDivider />

      <section id="faq" className={section} aria-labelledby="faq-heading">
        <h2 id="faq-heading" className={h2}>
          Questions
        </h2>
        <div className="mt-8 max-w-3xl divide-y border-y">
          {faq.map((item) => (
            <details key={item.question} className="group py-1">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 py-2 font-medium [&::-webkit-details-marker]:hidden">
                {item.question}
                <span
                  aria-hidden="true"
                  className="font-mono text-muted-foreground group-open:hidden"
                >
                  +
                </span>
                <span
                  aria-hidden="true"
                  className="hidden font-mono text-muted-foreground group-open:inline"
                >
                  -
                </span>
              </summary>
              <p className="pb-3 leading-relaxed text-muted-foreground">{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="py-12 md:py-20">
        <div className="rounded-xl border bg-card p-6 md:p-10">
          <h2 className="max-w-[24ch] text-3xl font-medium leading-[1.15] tracking-tight">
            {finalCta.title}
          </h2>
          <p className="mt-3 max-w-[56ch] text-muted-foreground">{finalCta.body}</p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link href="/sign-in" className={cta}>
              {hero.primaryCta}
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
