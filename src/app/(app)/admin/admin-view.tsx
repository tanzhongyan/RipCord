import { Card, CardContent, CardHeader, CardTitle } from "~/shared/components/ui/card";

export function AdminView({
  overview,
}: {
  overview: {
    queue: Array<{ id: string; providerName: string; address: string; verified: boolean }>;
    dsrs: Array<{ id: string; kind: string; status: string }>;
    audit: { ok: boolean; checked?: number; breakAtId?: number; total: number };
    spend: { period: string; rows: Array<{ ownerKey: string; costMicros: number }> };
    counts: {
      byStatus: Array<{ status: string; count: number }>;
      byProvider: Array<{ providerId: string | null; name: string | null; count: number }>;
    };
  };
}) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">Admin</h1>
      <Card>
        <CardHeader>
          <CardTitle>Provider review queue ({overview.queue.length})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {overview.queue.slice(0, 20).map((row) => (
            <div key={row.id} className="text-sm">
              {row.providerName} · {row.address} · {row.verified ? "verified" : "unverified"}
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Data subject requests ({overview.dsrs.length})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {overview.dsrs.map((row) => (
            <div key={row.id} className="text-sm">
              {row.kind} · {row.status}
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Audit chain</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">
            {overview.audit.ok
              ? `ok, checked ${overview.audit.checked}`
              : `break at ${overview.audit.breakAtId}`}{" "}
            · {overview.audit.total} rows
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Model spend {overview.spend.period}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {overview.spend.rows.map((row) => (
            <div key={row.ownerKey} className="text-sm">
              {row.ownerKey} · ${(row.costMicros / 1000000).toFixed(2)}
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Case counts</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {overview.counts.byStatus.map((row) => (
            <div key={row.status} className="text-sm">
              {row.status}: {row.count}
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Cases by provider</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {overview.counts.byProvider.map((row) => (
            <div key={row.providerId ?? "unknown"} className="text-sm">
              {row.name ?? "Unknown provider"}: {row.count}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
