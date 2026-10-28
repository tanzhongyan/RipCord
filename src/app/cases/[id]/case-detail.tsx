"use client";

import { useEffect, useState } from "react";

import { StatusBadge } from "~/shared/components/ui/badge";
import { Button } from "~/shared/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/shared/components/ui/card";
import { api } from "~/trpc/react";

interface StepRow {
  id: string;
  seq: number;
  tool: string;
  status: string;
  requiresApproval: boolean;
}

/** Case detail: timeline, recommendation, steps, live events, docs, receipt. */
export function CaseDetail({
  view,
}: {
  view: {
    case: { id: string; status: string; recommendation: unknown; failureReason: string | null };
    steps: StepRow[];
    terms: unknown;
    receipt: { referenceCode: string; effectiveDate: string } | null;
  };
}) {
  const [events, setEvents] = useState<Array<{ id: number; data: string }>>([]);
  const paste = api.cases.pasteReply.useMutation();

  useEffect(() => {
    let nextId = 0;
    const source = new EventSource(`/api/cases/${view.case.id}/events`);
    source.onmessage = (frame) => {
      nextId += 1;
      const id = nextId;
      setEvents((prev) => [...prev.slice(-19), { id, data: frame.data }]);
    };
    return () => source.close();
  }, [view.case.id]);

  const awaiting = view.steps.filter((step) => step.status === "AWAITING_APPROVAL");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Case {view.case.id.slice(0, 8)}</h1>
        <StatusBadge status={view.case.status} />
      </div>
      {view.case.failureReason && <p className="text-sm">Failed: {view.case.failureReason}</p>}
      <Card>
        <CardHeader>
          <CardTitle>Recommendation</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-xs">
            {JSON.stringify(view.case.recommendation ?? view.terms, null, 2)}
          </pre>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Steps</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {view.steps.map((step) => (
            <div key={step.id} className="flex items-center justify-between text-sm">
              <span>
                {step.seq} · {step.tool} · {step.status}
              </span>
              {step.status === "AWAITING_APPROVAL" && <Button size="sm">Approve</Button>}
            </div>
          ))}
          {awaiting.length === 0 && <p className="text-sm">No steps awaiting approval.</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Live transcript</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {events.length === 0 && <p className="text-sm">Waiting for events…</p>}
          {events.map((frame) => (
            <pre key={frame.id} className="text-xs">
              {frame.data}
            </pre>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Receipt</CardTitle>
        </CardHeader>
        <CardContent>
          {view.receipt ? (
            <p className="text-sm">
              {view.receipt.referenceCode} · {view.receipt.effectiveDate}
            </p>
          ) : (
            <p className="text-sm">No receipt yet.</p>
          )}
        </CardContent>
      </Card>
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() => paste.mutate({ caseId: view.case.id, text: "pasted reply" })}
        >
          Paste reply
        </Button>
        <Button variant="destructive">Withdraw</Button>
        <a className="text-sm underline" href={`/api/cases/${view.case.id}/dispute-package`}>
          Dispute package
        </a>
      </div>
    </div>
  );
}
