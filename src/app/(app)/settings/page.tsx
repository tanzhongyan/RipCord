import { headers } from "next/headers";
import Link from "next/link";

import { ConnectedAgentsList } from "~/features/identity";
import { auth } from "~/server/auth/auth";
import { Card, CardContent, CardHeader, CardTitle } from "~/shared/components/ui/card";
import { api } from "~/trpc/server";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  const holders = session ? await api.holders.list() : [];
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm break-all">{session?.user.email ?? "Not signed in"}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Organisations and members</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">Manage organisations in Better Auth.</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Holders</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {holders.map((holder: { id: string; alias: string }) => (
            <p key={holder.id} className="text-sm">
              {holder.alias}
            </p>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Connected agents</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <ConnectedAgentsList />
          <Link
            href="/settings/connected-agents"
            className="inline-flex min-h-11 items-center font-medium underline underline-offset-4"
          >
            Manage
          </Link>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Privacy</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">Request access or deletion from the privacy API.</p>
        </CardContent>
      </Card>
    </div>
  );
}
