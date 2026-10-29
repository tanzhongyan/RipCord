import Link from "next/link";

import { isTerminalStatus } from "~/features/cases/server/engine";
import { buttonVariants } from "~/shared/components/ui/button";
import { cn } from "~/shared/lib/utils";
import { api } from "~/trpc/server";
import { CaseList } from "./case-list";
import { StatCards } from "./stat-cards";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cursor?: string }>;
}) {
  const params = await searchParams;
  const [listed, all, balance] = await Promise.all([
    api.cases.list({
      status: params.status,
      cursor: params.cursor ?? null,
      limit: 25,
    }),
    // Unfiltered recent cases feed the stat cards, whatever the list filters say.
    api.cases.list({ cursor: null, limit: 100 }),
    api.billing.balance({}),
  ]);
  const isDone = (status: string) =>
    isTerminalStatus(status as Parameters<typeof isTerminalStatus>[0]);
  const last = all.cases.find((c) => isDone(c.status));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 md:py-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <Link href="/chat" className={cn(buttonVariants(), "h-11 px-4")}>
          New cancellation
        </Link>
      </div>
      <StatCards
        openCases={all.cases.filter((c) => !isDone(c.status)).length}
        openIsLowerBound={all.total > all.cases.length}
        balance={balance.balance}
        plan={balance.plan}
        lastOutcome={
          last
            ? {
                status: last.status,
                providerName: last.providerName,
                at: last.updatedAt ?? last.createdAt,
              }
            : null
        }
      />
      <CaseList
        cases={listed.cases}
        total={listed.total}
        nextCursor={listed.nextCursor}
        status={params.status}
      />
    </div>
  );
}
