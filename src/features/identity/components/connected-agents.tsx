"use client";

import { Button } from "~/shared/components/ui/button";
import { Card, CardContent } from "~/shared/components/ui/card";
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

function formatDate(value: Date | null): string {
  return value ? formatSgDate(new Date(value)) : "—";
}

export function ConnectedAgentsList() {
  const list = api.agents.list.useQuery();
  const revoke = api.agents.revoke.useMutation({
    onSuccess: () => list.refetch(),
  });

  if (list.isPending) return <p className="text-sm">Loading connected agents…</p>;
  if (list.isError) {
    return <p className="text-sm text-destructive">Could not load connected agents.</p>;
  }
  if (list.data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No assistant has access to your RipCord cases.
      </p>
    );
  }

  const revokeButton = (agent: { clientId: string; name: string | null }) => (
    <Button
      type="button"
      variant="outline"
      className="h-11 px-4"
      disabled={revoke.isPending}
      onClick={() => {
        if (window.confirm(`Revoke access for ${agent.name ?? "this assistant"}?`)) {
          revoke.mutate({ clientId: agent.clientId });
        }
      }}
    >
      {revoke.isPending ? "Revoking…" : "Revoke"}
    </Button>
  );

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Assistant</TableHead>
              <TableHead>Connected</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data.map((agent) => (
              <TableRow key={agent.clientId}>
                <TableCell className="font-medium">{agent.name ?? "Unnamed assistant"}</TableCell>
                <TableCell>{formatDate(agent.createdAt)}</TableCell>
                <TableCell>{formatDate(agent.lastUsedAt)}</TableCell>
                <TableCell className="text-right">{revokeButton(agent)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col gap-2 md:hidden">
        {list.data.map((agent) => (
          <li key={agent.clientId}>
            <Card>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <p className="font-semibold">{agent.name ?? "Unnamed assistant"}</p>
                  <p className="text-sm text-muted-foreground">
                    Connected {formatDate(agent.createdAt)} · Last used{" "}
                    {formatDate(agent.lastUsedAt)}
                  </p>
                </div>
                {revokeButton(agent)}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      {revoke.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Revoking failed. Try again.
        </p>
      ) : null}
    </div>
  );
}
