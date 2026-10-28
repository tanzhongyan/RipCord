"use client";

import { api } from "~/trpc/react";

function formatDate(value: Date | null): string {
  return value ? value.toLocaleDateString() : "—";
}

export function ConnectedAgentsList() {
  const list = api.agents.list.useQuery();
  const revoke = api.agents.revoke.useMutation({
    onSuccess: () => list.refetch(),
  });

  if (list.isPending) return <p className="text-sm">Loading connected agents…</p>;
  if (list.isError) return <p className="text-sm text-red-300">Could not load connected agents.</p>;
  if (list.data.length === 0) {
    return <p className="text-sm">No assistant has access to your RipCord cases.</p>;
  }

  return (
    <ul className="flex w-full max-w-lg flex-col gap-3">
      {list.data.map((agent) => (
        <li
          key={agent.clientId}
          className="flex items-center justify-between gap-4 rounded-lg border border-slate-700 px-4 py-3"
        >
          <div className="flex flex-col gap-1">
            <p className="font-semibold">{agent.name ?? "Unnamed assistant"}</p>
            <p className="text-sm text-slate-300">
              Connected {formatDate(agent.createdAt)} · Last used {formatDate(agent.lastUsedAt)}
            </p>
          </div>
          <button
            type="button"
            disabled={revoke.isPending}
            onClick={() => {
              if (window.confirm(`Revoke access for ${agent.name ?? "this assistant"}?`)) {
                revoke.mutate({ clientId: agent.clientId });
              }
            }}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm disabled:opacity-50"
          >
            {revoke.isPending ? "Revoking…" : "Revoke"}
          </button>
        </li>
      ))}
      {revoke.isError ? (
        <p role="alert" className="text-sm text-red-300">
          Revoking failed. Try again.
        </p>
      ) : null}
    </ul>
  );
}
