"use client";

export default function ErrorPage({ error }: { error: Error & { digest?: string } }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-2">
      <h1 className="text-2xl font-bold">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">
        {error.message.includes("UNAUTHORIZED") || error.message === "Authentication required"
          ? "Sign in to continue."
          : "Reload the page to try again."}
      </p>
    </main>
  );
}
