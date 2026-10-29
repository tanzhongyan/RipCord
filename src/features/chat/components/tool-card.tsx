import { CheckCircle2, Loader2, XCircle } from "lucide-react";

import { Button } from "~/shared/components/ui/button";

export interface ToolLine {
  callId: string;
  name: string;
  status: "running" | "ok" | "error";
  detail?: string;
}

export interface ConfirmRequest {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  summary: string;
}

const statusView = {
  running: { label: "Running…", Icon: Loader2, tone: "text-muted-foreground" },
  ok: { label: "Done", Icon: CheckCircle2, tone: "text-muted-foreground" },
  error: { label: "Failed", Icon: XCircle, tone: "text-destructive" },
} as const;

export function ToolCard({ line }: { line: ToolLine }) {
  const { label, Icon, tone } = statusView[line.status];
  const head = (
    <>
      <Icon
        aria-hidden
        className={`size-4 shrink-0 ${tone} ${line.status === "running" ? "motion-safe:animate-spin" : ""}`}
      />
      <span className="min-w-0 truncate font-mono text-xs">{line.name}</span>
      <span className={`ml-auto shrink-0 text-xs ${tone}`}>{label}</span>
    </>
  );
  return (
    <div className="max-w-[68ch] rounded-lg border bg-card text-card-foreground">
      {line.detail ? (
        <details>
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            {head}
          </summary>
          <p className="border-t px-3 py-2 text-xs [overflow-wrap:anywhere] text-muted-foreground">
            {line.detail}
          </p>
        </details>
      ) : (
        <div className="flex min-h-9 items-center gap-2 px-3 py-1.5">{head}</div>
      )}
    </div>
  );
}

function formatArg(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function ConfirmCard({
  card,
  busy,
  onAnswer,
}: {
  card: ConfirmRequest;
  busy: boolean;
  onAnswer: (approved: boolean) => void;
}) {
  const entries = Object.entries(card.args);
  return (
    <fieldset
      aria-label={`Confirm ${card.name}`}
      className="m-0 flex min-w-0 max-w-[68ch] flex-col gap-3 rounded-lg border bg-card p-3 text-card-foreground"
    >
      <p className="text-sm font-medium">Confirm: {card.name}</p>
      <p className="text-sm [overflow-wrap:anywhere]">{card.summary}</p>
      {entries.length > 0 ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="font-mono text-muted-foreground">{key}</dt>
              <dd className="font-mono [overflow-wrap:anywhere]">{formatArg(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="flex gap-2">
        <Button disabled={busy} onClick={() => onAnswer(true)} className="h-11 px-4 sm:h-9">
          Confirm
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => onAnswer(false)}
          className="h-11 px-4 sm:h-9"
        >
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}
