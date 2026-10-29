"use client";

import { useState } from "react";
import { Button } from "~/shared/components/ui/button";
import { Card, CardContent } from "~/shared/components/ui/card";

export function ConsentForm({
  clientName,
  scopes,
  oauthQuery,
}: {
  clientName: string;
  scopes: string[];
  oauthQuery: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (accept: boolean) => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accept, oauth_query: oauthQuery }),
      });
      const body = (await response.json()) as { url?: unknown };
      if (!response.ok || typeof body.url !== "string") {
        throw new Error("consent failed");
      }
      window.location.href = body.url;
    } catch {
      setError("That did not go through. Go back to your assistant and try again.");
      setPending(false);
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4">
        <p>
          <span className="font-semibold">{clientName}</span> wants to act on your RipCord cases.
        </p>
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">It asked for this access</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {scopes.map((scope) => (
              <li key={scope}>
                <code className="rounded bg-muted px-1.5 py-0.5 break-all">{scope}</code>
              </li>
            ))}
          </ul>
        </section>
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button
            type="button"
            disabled={pending}
            onClick={() => answer(true)}
            className="h-11 px-4 sm:flex-1"
          >
            {pending ? "Working…" : "Allow"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => answer(false)}
            className="h-11 px-4 sm:flex-1"
          >
            Deny
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
