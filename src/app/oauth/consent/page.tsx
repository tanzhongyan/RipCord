import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ConsentForm } from "~/features/identity";
import { readConsentClient } from "~/features/identity/server/agents";
import { auth } from "~/server/auth/auth";

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
    } catch {
      valid = false;
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center bg-slate-950 px-4 py-16 text-white">
      <div className="flex w-full max-w-lg flex-col gap-8">
        <h1 className="text-3xl font-bold">Connect an assistant</h1>
        {!valid || !clientId ? (
          <p className="text-sm">
            This authorisation request expired or is invalid. Go back to your assistant and try
            again.
          </p>
        ) : (
          <ConsentForm
            clientName={name ?? clientId}
            scopes={scopes}
            oauthQuery={rebuilt.toString()}
          />
        )}
      </div>
    </main>
  );
}
