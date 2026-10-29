"use client";

import Link from "next/link";
import { planLabel } from "~/features/billing/plan-labels";
import { Button } from "~/shared/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/shared/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/shared/components/ui/table";
import { formatSgDate } from "~/shared/lib/format-date";
import { api } from "~/trpc/react";

interface LedgerRow {
  id: string;
  delta: number;
  reason: string;
  createdAt: Date;
  stripeRef: string | null;
}

const REASON_LABELS: Record<string, string> = {
  PURCHASE: "Purchase",
  PLAN_GRANT: "Plan grant",
  CONSUME: "Cancellation",
  REFUND: "Refund",
  EXPIRE: "Expired",
  ADMIN_ADJUST: "Adjustment",
};

const label = (labels: Record<string, string>, key: string) => labels[key] ?? key;
const signed = (delta: number) => (delta > 0 ? `+${delta}` : String(delta));
const linkClass = "inline-flex min-h-11 items-center font-medium underline underline-offset-4";
const actionClass = "h-11 px-4";

export function BillingView({
  balance,
  ledger,
  orgs,
  priceDisplay,
}: {
  balance: { balance: number; plan: string };
  ledger: { rows: LedgerRow[]; page: number; pageSize: number; total: number };
  orgs: Array<{ orgId: string; role: string }>;
  priceDisplay: string;
}) {
  const checkout = api.billing.checkout.useMutation({
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });
  const portal = api.billing.portal.useMutation({
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });
  const subscribe = api.billing.subscribe.useMutation({
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });
  const ownedOrgs = orgs.filter((org) => org.role === "owner");
  const pageCount = Math.max(1, Math.ceil(ledger.total / ledger.pageSize));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Billing</h1>
        <p className="text-sm text-muted-foreground">
          One credit per cancellation · {priceDisplay}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Balance</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-4xl font-semibold tabular-nums">{balance.balance}</p>
            <p className="text-sm text-muted-foreground">
              {balance.balance === 1 ? "credit" : "credits"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Plan</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-2xl font-semibold">{planLabel(balance.plan)}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" className={actionClass} onClick={() => portal.mutate({})}>
                Manage billing
              </Button>
              {ownedOrgs.map((org) => (
                <Button
                  key={org.orgId}
                  variant="outline"
                  className={actionClass}
                  onClick={() => subscribe.mutate({ orgId: org.orgId })}
                >
                  Subscribe org
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Buy credits</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {[1, 5, 10].map((quantity) => (
              <Button
                key={quantity}
                className={actionClass}
                onClick={() => checkout.mutate({ quantity: quantity as 1 | 5 | 10 })}
              >
                Buy {quantity}
              </Button>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            Credits can take a few seconds to appear after payment.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {ledger.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No ledger rows.</p>
          ) : (
            <>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead className="text-right">Credits</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ledger.rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>{formatSgDate(new Date(row.createdAt))}</TableCell>
                        <TableCell>{label(REASON_LABELS, row.reason)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {signed(row.delta)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <ul className="flex flex-col gap-2 md:hidden">
                {ledger.rows.map((row) => (
                  <li key={row.id}>
                    <Card>
                      <CardContent className="flex items-center justify-between gap-3">
                        <div className="flex flex-col">
                          <span className="font-medium">{label(REASON_LABELS, row.reason)}</span>
                          <span className="text-sm text-muted-foreground">
                            {formatSgDate(new Date(row.createdAt))}
                          </span>
                        </div>
                        <span className="font-mono tabular-nums">{signed(row.delta)}</span>
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="flex gap-4">
            {ledger.page > 1 && (
              <Link href={`/billing?page=${ledger.page - 1}`} className={linkClass}>
                Previous
              </Link>
            )}
            {ledger.page < pageCount && (
              <Link href={`/billing?page=${ledger.page + 1}`} className={linkClass}>
                Next
              </Link>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
