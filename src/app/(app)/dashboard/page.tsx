import Link from "next/link";

import { api } from "~/trpc/server";
import { CaseList } from "./case-list";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; holderId?: string; cursor?: string }>;
}) {
  const params = await searchParams;
  const [listed, balance] = await Promise.all([
    api.cases.list({
      status: params.status,
      holderId: params.holderId,
      cursor: params.cursor ?? null,
      limit: 25,
    }),
    api.billing.balance({}),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {balance.balance} credits · {balance.plan}
          </p>
        </div>
        <Link
          href="/chat"
          className="inline-flex h-8 items-center rounded-lg bg-primary px-2.5 text-sm font-medium text-primary-foreground"
        >
          New cancellation
        </Link>
      </div>
      <CaseList
        cases={listed.cases}
        total={listed.total}
        nextCursor={listed.nextCursor}
        status={params.status}
        holderId={params.holderId}
      />
    </div>
  );
}
