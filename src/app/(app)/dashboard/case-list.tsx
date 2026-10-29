import Link from "next/link";
import { StatusBadge } from "~/shared/components/ui/badge";
import { Card, CardContent } from "~/shared/components/ui/card";

export interface DashboardCaseRow {
  id: string;
  status: string;
  providerId: string | null;
  providerName: string | null;
  holderId: string;
  holderAlias: string;
  updatedAt: Date | null;
  createdAt: Date;
}

/** Case list with status filter and cursor pagination. Server-rendered. */
export function CaseList({
  cases,
  total,
  nextCursor,
  status,
  holderId,
}: {
  cases: DashboardCaseRow[];
  total: number;
  nextCursor: string | null;
  status?: string;
  holderId?: string;
}) {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (holderId) params.set("holderId", holderId);
  const nextHref = nextCursor
    ? `/dashboard?${params.toString()}&cursor=${encodeURIComponent(nextCursor)}`
    : null;
  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-wrap gap-2" method="get">
        <input
          name="status"
          placeholder="Status"
          defaultValue={status ?? ""}
          className="min-w-0 rounded-md border px-2 py-1 text-sm"
        />
        <input
          name="holderId"
          placeholder="Holder ID"
          defaultValue={holderId ?? ""}
          className="min-w-0 rounded-md border px-2 py-1 text-sm"
        />
        <button type="submit" className="rounded-md border px-3 py-1 text-sm">
          Filter
        </button>
      </form>
      <p className="text-sm text-muted-foreground">
        {cases.length} of {total} cases
      </p>
      <div className="flex flex-col gap-2">
        {cases.map((c) => (
          <Card key={c.id}>
            <CardContent className="flex items-center justify-between gap-4">
              <div className="flex flex-col gap-1">
                <Link href={`/cases/${c.id}`} className="font-medium underline">
                  {c.holderAlias}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {c.providerName ?? "Unknown provider"} ·{" "}
                  {(c.updatedAt ?? c.createdAt).toISOString().slice(0, 10)}
                </span>
              </div>
              <StatusBadge status={c.status} />
            </CardContent>
          </Card>
        ))}
      </div>
      {nextHref && (
        <Link href={nextHref} className="text-sm underline">
          Next page
        </Link>
      )}
    </div>
  );
}
