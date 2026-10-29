import { Card, CardContent, CardHeader, CardTitle } from "~/shared/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/shared/components/ui/table";

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
  const o = overview;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight">Admin</h1>
      <Panel title={`Provider review queue (${o.queue.length})`}>
        <Rows
          headers={["Provider", "Address", "Status"]}
          empty="Nothing to review."
          rows={o.queue.slice(0, 20).map((r) => ({
            key: r.id,
            cells: [r.providerName, r.address, r.verified ? "Verified" : "Unverified"],
          }))}
        />
      </Panel>
      <Panel title={`Data subject requests (${o.dsrs.length})`}>
        <Rows
          headers={["Kind", "Status"]}
          empty="No requests."
          rows={o.dsrs.map((r) => ({ key: r.id, cells: [r.kind, r.status] }))}
        />
      </Panel>
      <Panel title="Audit chain">
        <p className="text-sm">
          {o.audit.ok ? `ok, checked ${o.audit.checked}` : `break at ${o.audit.breakAtId}`} ·{" "}
          {o.audit.total} rows
        </p>
      </Panel>
      <Panel title={`Model spend ${o.spend.period}`}>
        <Rows
          headers={["Owner", "Cost"]}
          empty="No spend yet."
          rows={o.spend.rows.map((r) => ({
            key: r.ownerKey,
            cells: [r.ownerKey, `$${(r.costMicros / 1000000).toFixed(2)}`],
          }))}
        />
      </Panel>
      <Panel title="Case counts">
        <Rows
          headers={["Status", "Cases"]}
          empty="No cases."
          rows={o.counts.byStatus.map((r) => ({
            key: r.status,
            cells: [r.status, String(r.count)],
          }))}
        />
      </Panel>
      <Panel title="Cases by provider">
        <Rows
          headers={["Provider", "Cases"]}
          empty="No cases."
          rows={o.counts.byProvider.map((r) => ({
            key: r.providerId ?? "unknown",
            cells: [r.name ?? "Unknown provider", String(r.count)],
          }))}
        />
      </Panel>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** Table at md+, stacked label/value cards below (the case-list pattern). */
function Rows({
  headers,
  rows,
  empty,
}: {
  headers: string[];
  rows: Array<{ key: string; cells: string[] }>;
  empty: string;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <>
      <div className="hidden lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              {headers.map((h) => (
                <TableHead key={h}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                {row.cells.map((cell, i) => (
                  <TableCell key={headers[i]}>{cell}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col gap-2 lg:hidden">
        {rows.map((row) => (
          <li key={row.key} className="rounded-lg border p-3">
            <dl className="flex flex-col gap-1 text-sm">
              {row.cells.map((cell, i) => (
                <div key={headers[i]} className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{headers[i]}</dt>
                  <dd className="min-w-0 text-right break-words">{cell}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}
