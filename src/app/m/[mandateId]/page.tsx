import { headers } from "next/headers";

import { MandateReview } from "~/features/identity";
import { INVALID_LINK_MESSAGE, loadMandateView } from "~/features/identity/server/mandate-flow";
import { auth } from "~/server/auth/auth";
import { HolderShell } from "~/shared/components/holder-shell";

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
    <HolderShell title="Authorisation request">
      {!result.ok ? (
        <p>{INVALID_LINK_MESSAGE}</p>
      ) : (
        <MandateReview view={result.view} token={typeof t === "string" ? t : null} />
      )}
    </HolderShell>
  );
}
