"use client";

import { MenuIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button, buttonVariants } from "~/shared/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "~/shared/components/ui/sheet";
import type { NavLink } from "~/shared/config/site";

const linkClass =
  "inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-muted-foreground hover:text-foreground";

/** Inline nav, shown from `md` up. */
export function NavLinks({ items }: { items: NavLink[] }) {
  return (
    <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
      {items.map((item) => (
        <Link key={item.href} href={item.href} className={linkClass}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

/** Menu button and sheet, shown below `md`. Holds the nav and both actions. */
export function MobileNav({ items }: { items: NavLink[] }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open menu"
            className="size-11 md:hidden"
          />
        }
      >
        <MenuIcon />
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Menu</SheetTitle>
          <SheetDescription className="sr-only">Site navigation</SheetDescription>
        </SheetHeader>
        <nav aria-label="Mobile" className="flex flex-col gap-1 px-4">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={close}
              className="py-3 text-base font-medium"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 p-4">
          <Link href="/dashboard" onClick={close} className={buttonVariants({ size: "lg" })}>
            Open app
          </Link>
          <Link
            href="/sign-in"
            onClick={close}
            className={buttonVariants({ variant: "ghost", size: "lg" })}
          >
            Sign in
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}
