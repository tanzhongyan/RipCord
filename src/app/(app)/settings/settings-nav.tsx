"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "~/shared/lib/utils";

const TABS = [
  { href: "/settings", label: "Account" },
  { href: "/settings/connected-agents", label: "Connected agents" },
] as const;

/** Sub-nav between the two settings routes. Scrolls sideways inside its own bar. */
export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings sections" className="overflow-x-auto border-b">
      <ul className="flex w-max min-w-full gap-1">
        {TABS.map((tab) => {
          const active = pathname === tab.href;
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-3 text-sm font-medium",
                  active
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
