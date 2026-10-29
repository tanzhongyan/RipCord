import { planLabel } from "~/features/billing/plan-labels";
import { statusLabel } from "~/features/cases/status";
import { StatusBadge } from "~/shared/components/ui/badge";
import { Card, CardContent } from "~/shared/components/ui/card";
import { formatSgDate } from "~/shared/lib/format-date";

export interface LastOutcome {
  status: string;
  providerName: string | null;
  at: Date;
}

/** Three summary cards: 3 per row at lg, 2 at sm, 1 below. */
export function StatCards({
  openCases,
  openIsLowerBound,
  balance,
  plan,
  lastOutcome,
}: {
  openCases: number;
  openIsLowerBound?: boolean;
  balance: number;
  plan: string;
  lastOutcome: LastOutcome | null;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Card>
        <CardContent className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">Open cases</p>
          <p className="text-2xl font-semibold">
            {openCases}
            {openIsLowerBound ? "+" : ""}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">Credit balance</p>
          <p className="text-2xl font-semibold">{balance}</p>
          <p className="text-xs text-muted-foreground">{planLabel(plan)} plan</p>
        </CardContent>
      </Card>
      <Card className="sm:col-span-2 lg:col-span-1">
        <CardContent className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">Last outcome</p>
          {lastOutcome ? (
            <>
              <div>
                <StatusBadge status={lastOutcome.status} label={statusLabel(lastOutcome.status)} />
              </div>
              <p className="text-xs text-muted-foreground">
                {lastOutcome.providerName ?? "Unknown provider"} · {formatSgDate(lastOutcome.at)}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No finished cases yet</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
