import { headers } from "next/headers";

import { MandateReview } from "~/features/identity";
import { INVALID_LINK_MESSAGE, loadMandateView } from "~/features/identity/server/mandate-flow";
import { auth } from "~/server/auth/auth";

export const dynamic = "force-dynamic";

export default async function MandatePage({
  params,
  searchParams,
}: {
  params: Promise<{ mandateId: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { mandateId } = await params;
  const { t } = await searchParams;
  const session = await auth.api.getSession({ headers: await headers() });
  const result = await loadMandateView(
    { mandateId, token: typeof t === "string" ? t : undefined },
    session?.user.id ?? null,
  );

  return (
    <main className="flex min-h-screen flex-col items-center bg-slate-950 px-4 py-16 text-white">
      <div className="flex w-full max-w-lg flex-col gap-8">
        <h1 className="text-3xl font-bold">Authorisation request</h1>
        {!result.ok ? (
          <p>{INVALID_LINK_MESSAGE}</p>
        ) : (
          <MandateReview view={result.view} token={typeof t === "string" ? t : null} />
        )}
      </div>
    </main>
  );
}
