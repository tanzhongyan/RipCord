import { headers } from "next/headers";

import { SignInForm, SignOutButton } from "~/features/identity";
import { auth } from "~/server/auth/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await auth.api.getSession({ headers: await headers() });

  return (
    <div className="flex flex-1 flex-col items-center bg-slate-950 px-4 py-16 text-white">
      <div className="flex w-full max-w-sm flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-4xl font-bold">RipCord</h1>
          <p className="text-sm">Cancel services without the phone calls.</p>
        </div>
        {session ? (
          <div className="flex flex-col items-center gap-4">
            <p className="text-sm">Signed in as {session.user.email}</p>
            <SignOutButton />
          </div>
        ) : (
          <SignInForm />
        )}
      </div>
    </div>
  );
}
