"use client";

import Link from "next/link";
import { Button } from "~/shared/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/shared/components/ui/card";
import { api } from "~/trpc/react";

interface LedgerRow {
  id: string;
  delta: number;
  reason: string;
  createdAt: Date;
  stripeRef: string | null;
}

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
      <h1 className="text-2xl font-bold">Billing</h1>
      <p className="text-sm text-muted-foreground">One credit per cancellation · {priceDisplay}</p>
      <Card>
        <CardHeader>
          <CardTitle>
            {balance.balance} credits · {balance.plan}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2">
          {[1, 5, 10].map((quantity) => (
            <Button
              key={quantity}
              size="sm"
              onClick={() => checkout.mutate({ quantity: quantity as 1 | 5 | 10 })}
            >
              Buy {quantity}
            </Button>
          ))}
          <Button size="sm" variant="outline" onClick={() => portal.mutate({})}>
            Portal
          </Button>
          {ownedOrgs.map((org) => (
            <Button
              key={org.orgId}
              size="sm"
              variant="outline"
              onClick={() => subscribe.mutate({ orgId: org.orgId })}
            >
              Subscribe org
            </Button>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Ledger</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {ledger.rows.map((row) => (
            <div key={row.id} className="flex justify-between text-sm">
              <span>
                {row.reason} {row.delta > 0 ? `+${row.delta}` : row.delta}
              </span>
              <span className="text-muted-foreground">
                {new Date(row.createdAt).toISOString().slice(0, 10)}
              </span>
            </div>
          ))}
          {ledger.rows.length === 0 && <p className="text-sm">No ledger rows.</p>}
          <div className="flex gap-4 pt-2 text-sm">
            {ledger.page > 1 && (
              <Link href={`/billing?page=${ledger.page - 1}`} className="underline">
                Previous
              </Link>
            )}
            {ledger.page < pageCount && (
              <Link href={`/billing?page=${ledger.page + 1}`} className="underline">
                Next
              </Link>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
