"use client";

import Link from "next/link";
import { cn } from "~/shared/lib/utils";
import { Button, buttonVariants } from "./ui/button";

export function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      role="alert"
      className="mx-auto flex w-full max-w-md flex-col items-center gap-3 px-4 py-12 text-center"
    >
      <h2 className="text-lg font-medium">Something went wrong loading this page.</h2>
      {error.digest ? (
        <p className="font-mono text-xs break-all text-muted-foreground">
          Reference: {error.digest}
        </p>
      ) : null}
      <div className="mt-2 flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
        <Button className="h-11 px-4" onClick={reset}>
          Try again
        </Button>
        <Link href="/" className={cn(buttonVariants({ variant: "outline" }), "h-11 px-4")}>
          Go home
        </Link>
      </div>
    </div>
  );
}
