import { headers } from "next/headers";
import Link from "next/link";

import { ConnectedAgentsList } from "~/features/identity";
import { auth } from "~/server/auth/auth";
import { api } from "~/trpc/server";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  const holders = session ? await api.holders.list() : [];
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-4 py-8">
      <h1 className="text-2xl font-bold">Settings</h1>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Profile</h2>
        <p className="text-sm">{session?.user.email ?? "Not signed in"}</p>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Organisations and members</h2>
        <p className="text-sm">Manage organisations in Better Auth.</p>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Holders</h2>
        {holders.map((holder: { id: string; alias: string }) => (
          <p key={holder.id} className="text-sm">
            {holder.alias}
          </p>
        ))}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Connected agents</h2>
        <ConnectedAgentsList />
        <Link href="/settings/connected-agents" className="text-sm underline">
          Manage
        </Link>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Privacy</h2>
        <p className="text-sm">Request access or deletion from the privacy API.</p>
      </section>
    </main>
  );
}
