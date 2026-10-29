import Link from "next/link";

import { BrandMark } from "~/shared/components/brand-mark";
import { MobileNav, NavLinks } from "~/shared/components/nav-links";
import { buttonVariants } from "~/shared/components/ui/button";
import { site } from "~/shared/config/site";
import { cn } from "~/shared/lib/utils";

/** Static on purpose: it never reads the session, so public pages stay static. */
export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4">
        <Link
          href="/"
          aria-label={`${site.name} home`}
          className="flex min-h-11 items-center gap-2"
        >
          <BrandMark />
          <span className="font-medium tracking-tight">{site.name.toLowerCase()}</span>
        </Link>
        <NavLinks items={site.nav.primary} />
        <div className="hidden items-center gap-2 md:flex">
          <Link href="/sign-in" className={cn(buttonVariants({ variant: "ghost" }), "h-11 px-4")}>
            Sign in
          </Link>
          <Link href="/dashboard" className={cn(buttonVariants(), "h-11 px-4")}>
            Open app
          </Link>
        </div>
        <MobileNav items={site.nav.primary} />
      </div>
    </header>
  );
}
