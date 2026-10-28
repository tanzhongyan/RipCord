import { headers } from "next/headers";
import Link from "next/link";

import { ChatClient } from "~/features/chat";
import { auth } from "~/server/auth/auth";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ caseId?: string }>;
}) {
  const { caseId } = await searchParams;
  const session = await auth.api.getSession({ headers: await headers() });

  return (
    <main className="flex min-h-screen flex-col items-center bg-slate-950 px-4 py-16 text-white">
      <div className="flex w-full max-w-2xl flex-col items-center gap-8">
        <h1 className="text-3xl font-bold">Chat</h1>
        {!session?.user ? (
          <p className="text-sm">
            <Link href="/sign-in" className="underline">
              Sign in
            </Link>{" "}
            to chat with RipCord.
          </p>
        ) : (
          <ChatClient caseId={typeof caseId === "string" ? caseId : null} />
        )}
      </div>
    </main>
  );
}
