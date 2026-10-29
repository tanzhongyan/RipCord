"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { CaseProgress } from "~/features/cases/components/case-progress";
import { statusLabel } from "~/features/cases/status";
import { timelineSentence } from "~/features/cases/timeline";
import { StatusBadge } from "~/shared/components/ui/badge";
import { Button } from "~/shared/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/shared/components/ui/card";
import { formatSgDate } from "~/shared/lib/format-date";
import { api } from "~/trpc/react";
import { CaseChatSheet } from "./case-chat-sheet";

interface StepRow {
  id: string;
  seq: number;
  tool: string;
  status: string;
  requiresApproval: boolean;
}

interface TimelineRow {
  id: number;
  action: string;
  actorType: string;
  actorId: string;
  createdAt: Date;
}

interface DocumentRow {
  id: string;
  kind: string;
  createdAt: Date;
}

interface VerificationRow {
  dueAt: Date;
  result: string | null;
  resolvedAt: Date | null;
}

/** Case detail: timeline, recommendation, steps, live events, docs, receipt. */
export function CaseDetail({
  view,
  timeline,
  documents,
  verification,
  providerName,
  holderAlias = null,
}: {
  view: {
    case: {
      id: string;
      status: string;
      serviceType: string | null;
      recommendation: unknown;
      failureReason: string | null;
      // `cases.get` passes through `redactJson`, so these arrive as ISO strings at runtime.
      createdAt: Date;
      updatedAt: Date | null;
      closedAt: Date | null;
    };
    steps: StepRow[];
    terms: unknown;
    receipt: { referenceCode: string; effectiveDate: string } | null;
  };
  timeline: TimelineRow[];
  documents: DocumentRow[];
  verification: VerificationRow | null;
  providerName: string | null;
  holderAlias?: string | null;
}) {
  const [events, setEvents] = useState<Array<{ id: number; data: string }>>([]);
  const router = useRouter();
  const paste = api.cases.pasteReply.useMutation();
  const approve = api.cases.approveStep.useMutation({ onSuccess: () => router.refresh() });
  const withdraw = api.cases.withdraw.useMutation({ onSuccess: () => router.refresh() });

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
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-2xl font-semibold">
              {providerName ?? "Unknown provider"}
              {view.case.serviceType ? ` · ${view.case.serviceType}` : ""}
            </h1>
            <p className="font-mono text-xs break-all text-muted-foreground">{view.case.id}</p>
          </div>
          <StatusBadge status={view.case.status} label={statusLabel(view.case.status)} />
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <div className="flex gap-1.5">
            <dt>Opened</dt>
            <dd className="text-foreground">{formatSgDate(new Date(view.case.createdAt))}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt>Updated</dt>
            <dd className="text-foreground">
              {formatSgDate(new Date(view.case.updatedAt ?? view.case.createdAt))}
            </dd>
          </div>
          {view.case.closedAt ? (
            <div className="flex gap-1.5">
              <dt>Closed</dt>
              <dd className="text-foreground">{formatSgDate(new Date(view.case.closedAt))}</dd>
            </div>
          ) : null}
        </dl>
        <div>
          <CaseChatSheet caseId={view.case.id} providerName={providerName} />
        </div>
      </header>
      <Card>
        <CardContent>
          <CaseProgress
            status={view.case.status}
            failureReason={view.case.failureReason}
            disputeHref={`/api/cases/${view.case.id}/dispute-package`}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {timeline.length === 0 && <p className="text-sm">No audit entries yet.</p>}
          {timeline.map((row) => (
            <p key={row.id} className="text-sm">
              {timelineSentence(row, holderAlias)}
              <span className="text-muted-foreground"> on {formatSgDate(row.createdAt)}</span>
            </p>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recommendation</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto text-xs whitespace-pre-wrap break-all">
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
              {step.status === "AWAITING_APPROVAL" && (
                <Button
                  size="sm"
                  disabled={approve.isPending}
                  onClick={() => approve.mutate({ caseId: view.case.id, stepId: step.id })}
                >
                  Approve
                </Button>
              )}
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
            <pre key={frame.id} className="text-xs whitespace-pre-wrap break-all">
              {frame.data}
            </pre>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {documents.length === 0 && <p className="text-sm">No documents yet.</p>}
          {documents.map((doc) => (
            <p key={doc.id} className="text-sm">
              {doc.kind} · {formatSgDate(doc.createdAt)}
            </p>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Verification</CardTitle>
        </CardHeader>
        <CardContent>
          {verification ? (
            <p className="text-sm">
              Due {formatSgDate(verification.dueAt)} · Bill check:{" "}
              {verification.result ?? "pending"}
              {verification.resolvedAt && ` · resolved ${formatSgDate(verification.resolvedAt)}`}
            </p>
          ) : (
            <p className="text-sm">No verification yet.</p>
          )}
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
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          className="h-11 px-4"
          onClick={() => paste.mutate({ caseId: view.case.id, text: "pasted reply" })}
        >
          Paste reply
        </Button>
        <Button
          variant="destructive"
          className="h-11 px-4"
          disabled={withdraw.isPending}
          onClick={() => withdraw.mutate({ caseId: view.case.id })}
        >
          Withdraw
        </Button>
        <a
          className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
          href={`/api/cases/${view.case.id}/dispute-package`}
        >
          Dispute package
        </a>
      </div>
    </div>
  );
}
