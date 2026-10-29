import { TRPCError } from "@trpc/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ConsentForm } from "~/features/identity";
import { readConsentClient } from "~/features/identity/server/agents";
import { auth } from "~/server/auth/auth";
import { HolderShell } from "~/shared/components/holder-shell";

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/sign-in");

  const clientId = first(params.client_id);
  const scopes = (first(params.scope) ?? "").split(" ").filter((scope) => scope.length > 0);
  const rebuilt = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) rebuilt.append(key, entry);
  }

  let name: string | null = null;
  let valid = false;
  if (clientId) {
    try {
      const client = await readConsentClient({ clientId, oauthQuery: rebuilt.toString() });
      name = client.name;
      valid = true;
    } catch (error) {
      // Only an expired/tampered query or an unknown client renders the
      // invalid-request message; anything else (database, crypto, wiring)
      // bubbles to the error boundary instead of masquerading as expiry.
      if (
        error instanceof TRPCError &&
        (error.code === "BAD_REQUEST" || error.code === "NOT_FOUND")
      ) {
        valid = false;
      } else {
        throw error;
      }
    }
  }

  return (
    <HolderShell title="Connect an assistant">
      {!valid || !clientId ? (
        <p className="text-sm">
          This authorisation request expired or is invalid. Go back to your assistant and try again.
        </p>
      ) : (
        <ConsentForm
          clientName={name ?? clientId}
          scopes={scopes}
          oauthQuery={rebuilt.toString()}
        />
      )}
    </HolderShell>
  );
}
