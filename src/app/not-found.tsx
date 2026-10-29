import Link from "next/link";

import { BrandMark } from "~/shared/components/brand-mark";
import { buttonVariants } from "~/shared/components/ui/button";
import { site } from "~/shared/config/site";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <Link href="/" className="flex items-center gap-2">
        <BrandMark />
        <span className="font-medium tracking-tight">{site.name.toLowerCase()}</span>
      </Link>
      <h1 className="text-4xl leading-[1.15] font-semibold tracking-tight">Page not found</h1>
      <p className="text-muted-foreground">That address doesn't exist, or it moved.</p>
      <Link href="/" className={buttonVariants({ variant: "outline" })}>
        Back to home
      </Link>
    </main>
  );
}
