import { Inbox } from "lucide-react";
import Link from "next/link";
import { CASE_STATUS_LABELS, statusLabel } from "~/features/cases/status";
import { EmptyState } from "~/shared/components/empty-state";
import { StatusBadge } from "~/shared/components/ui/badge";
import { Button, buttonVariants } from "~/shared/components/ui/button";
import { Card, CardContent } from "~/shared/components/ui/card";
import { NativeSelect } from "~/shared/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/shared/components/ui/table";
import { formatSgDate } from "~/shared/lib/format-date";
import { cn } from "~/shared/lib/utils";

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

const linkClass = "inline-flex min-h-11 items-center font-medium underline underline-offset-4";

/** Case list with a status select and cursor pagination. Table at md+, cards below. */
export function CaseList({
  cases,
  total,
  nextCursor,
  status,
}: {
  cases: DashboardCaseRow[];
  total: number;
  nextCursor: string | null;
  status?: string;
}) {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  const nextHref = nextCursor
    ? `/dashboard?${params.toString()}&cursor=${encodeURIComponent(nextCursor)}`
    : null;
  const filtered = Boolean(status);

  if (cases.length === 0 && !filtered) {
    return (
      <EmptyState
        icon={Inbox}
        title="Start your first cancellation"
        body="Tell us which subscription to cancel. We handle the rest and show every step here."
        cta={{ href: "/chat", label: "Start a cancellation" }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-col gap-2 sm:flex-row" method="get">
        <NativeSelect
          name="status"
          aria-label="Status"
          defaultValue={status ?? ""}
          className="h-11 sm:w-56"
        >
          <option value="">All statuses</option>
          {Object.entries(CASE_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
        <Button type="submit" variant="outline" className="h-11 px-4">
          Filter
        </Button>
        {filtered ? (
          <Link href="/dashboard" className={cn(buttonVariants({ variant: "ghost" }), "h-11 px-4")}>
            Clear filters
          </Link>
        ) : null}
      </form>
      {cases.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed p-6 text-center">
          <p className="font-medium">No cases match these filters</p>
          <Link href="/dashboard" className={linkClass}>
            Show all cases
          </Link>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {cases.length} of {total} cases
          </p>
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Holder</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cases.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.providerName ?? "Unknown provider"}</TableCell>
                    <TableCell>
                      <Link href={`/cases/${c.id}`} className={linkClass}>
                        {c.holderAlias}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={c.status} label={statusLabel(c.status)} />
                    </TableCell>
                    <TableCell>{formatSgDate(c.updatedAt ?? c.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="flex flex-col gap-2 md:hidden">
            {cases.map((c) => (
              <li key={c.id}>
                <Card>
                  <CardContent className="flex flex-col gap-1">
                    <div className="flex items-start justify-between gap-3">
                      <span className="font-medium">{c.providerName ?? "Unknown provider"}</span>
                      <StatusBadge status={c.status} label={statusLabel(c.status)} />
                    </div>
                    <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                      <Link href={`/cases/${c.id}`} className={cn(linkClass, "text-foreground")}>
                        {c.holderAlias}
                      </Link>
                      <span>{formatSgDate(c.updatedAt ?? c.createdAt)}</span>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
      {nextHref && (
        <Link href={nextHref} className={linkClass}>
          Next page
        </Link>
      )}
    </div>
  );
}
