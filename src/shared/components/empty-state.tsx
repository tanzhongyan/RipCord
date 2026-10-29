import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { cn } from "~/shared/lib/utils";
import { buttonVariants } from "./ui/button";

export function EmptyState({
  icon: Icon,
  title,
  body,
  cta,
  className,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  cta?: { href: string; label: string };
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-full flex-col items-center gap-3 rounded-xl border border-dashed p-6 text-center md:p-10",
        className,
      )}
    >
      <Icon className="size-8 text-muted-foreground" aria-hidden="true" />
      <h2 className="text-lg font-medium">{title}</h2>
      <p className="max-w-prose text-sm text-muted-foreground">{body}</p>
      {cta ? (
        <Link href={cta.href} className={cn(buttonVariants(), "mt-2 h-11 px-4")}>
          {cta.label}
        </Link>
      ) : null}
    </div>
  );
}
