"use client";

export default function GlobalError() {
  return (
    <html lang="en">
      <body>
        <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
          <h1 className="text-4xl leading-[1.15] font-semibold tracking-tight">
            Something went wrong
          </h1>
          <p>We couldn't load this page. Try again in a moment.</p>
          <a href="/" className="underline underline-offset-4">
            Back to home
          </a>
        </main>
      </body>
    </html>
  );
}
