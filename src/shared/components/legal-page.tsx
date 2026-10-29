import { site } from "~/shared/config/site";

export interface LegalSection {
  heading: string;
  body: string[];
}

export function LegalPage({
  title,
  intro,
  sections,
}: {
  title: string;
  intro: string;
  sections: LegalSection[];
}) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12 md:py-16">
      <h1 className="text-4xl leading-[1.15] font-semibold tracking-tight md:text-5xl">{title}</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        {intro} Contact {site.legal.contactEmail}.
      </p>
      {sections.map((section) => (
        <section key={section.heading} className="mt-8">
          <h2 className="text-2xl leading-[1.15] font-medium">{section.heading}</h2>
          {section.body.map((paragraph) => (
            <p key={paragraph.slice(0, 40)} className="mt-3 text-base text-muted-foreground">
              {paragraph}
            </p>
          ))}
        </section>
      ))}
    </main>
  );
}
