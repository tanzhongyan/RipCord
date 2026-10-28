"use client";

import { useState } from "react";

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
    <div className="flex w-full max-w-sm flex-col gap-4">
      <p className="text-sm">
        <span className="font-semibold">{clientName}</span> wants to act on your RipCord cases.
      </p>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold">It asked for this access:</p>
        <ul className="list-disc pl-5 text-sm">
          {scopes.map((scope) => (
            <li key={scope}>
              <code className="rounded bg-slate-800 px-1">{scope}</code>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => answer(true)}
          className="rounded-lg bg-slate-100 px-4 py-2 font-semibold text-slate-900 disabled:opacity-50"
        >
          {pending ? "Working…" : "Allow"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => answer(false)}
          className="rounded-lg border border-slate-600 px-4 py-2 disabled:opacity-50"
        >
          Deny
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
