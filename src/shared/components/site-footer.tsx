import Link from "next/link";

import { site } from "~/shared/config/site";

const legalLinks = [
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
  { label: "Refunds", href: "/refund" },
];

export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          © {new Date().getFullYear()} {site.name} · {site.legal.contactEmail}
        </p>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-4 gap-y-1">
          {legalLinks.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
