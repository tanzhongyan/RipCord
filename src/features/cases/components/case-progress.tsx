import { Check } from "lucide-react";
import { cn } from "~/shared/lib/utils";
import { failureReasonText, statusLabel } from "../status";

/** Lifecycle steps in order (data contract "Case lifecycle"); the last is the happy ending. */
const PATH = [
  "DRAFT",
  "DISCOVERY",
  "PRE_FLIGHT_AUDIT",
  "AWAITING_MANDATE",
  "CHANNEL_PLANNING",
  "EXECUTING",
  "RECEIPT_ACQUISITION",
  "AWAITING_VERIFICATION",
  "SUCCEEDED",
] as const;

/** Rope tips from mark A: the left tip rises, the right tip dips. Coral `cut` token. */
function Snap() {
  return (
    <span aria-hidden="true" className="block size-9 shrink-0 rotate-90 text-cut lg:rotate-0">
      <svg viewBox="0 0 28 28" fill="none" className="size-9" role="presentation">
        <path
          d="M0 14H9C12 14 13 12 13.5 8"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M14.5 20C15 16 16 14 19 14H28"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

const segment = "w-0.5 flex-1 lg:h-0.5 lg:w-auto";

function Connector({ filled, snapped }: { filled: boolean; snapped: boolean }) {
  const tone = filled || snapped ? "bg-foreground" : "bg-border";
  return (
    <li
      aria-hidden="true"
      className={cn(
        snapped ? "h-14 lg:-mt-2" : "h-7 lg:mt-[9px]",
        "flex w-5 flex-col items-center lg:h-auto lg:w-auto lg:min-w-2 lg:flex-1 lg:flex-row lg:self-start",
      )}
    >
      <span className={cn(segment, tone)} />
      {snapped ? <Snap /> : null}
      {snapped ? <span className={cn(segment, tone)} /> : null}
    </li>
  );
}

/**
 * Case progress: the signature rope line through the lifecycle steps. It snaps at
 * `SUCCEEDED` and `DISPUTED`; `FAILED` and `WITHDRAWN` show a muted unbroken line.
 * Horizontal at lg+, vertical below: with the 240 px sidebar, md leaves only 512 px for nine steps.
 */
export function CaseProgress({
  status,
  failureReason,
  disputeHref,
}: {
  status: string;
  failureReason?: string | null;
  disputeHref?: string;
}) {
  const stopped = status === "FAILED" || status === "WITHDRAWN";
  const disputed = status === "DISPUTED";
  const snapped = status === "SUCCEEDED" || disputed;
  const current = disputed ? PATH.length - 1 : stopped ? -1 : PATH.indexOf(status as never);

  return (
    <section aria-label="Case progress" className="flex flex-col gap-3">
      <ol className="flex flex-col lg:flex-row lg:items-start">
        {PATH.flatMap((step, i) => {
          const reached = !stopped && (i < current || (snapped && i === current));
          const isCurrent = i === current && !snapped;
          const last = i === PATH.length - 1;
          const label = last && disputed ? "Disputed" : statusLabel(step);
          const item = (
            <li
              key={step}
              aria-current={isCurrent ? "step" : undefined}
              data-state={reached ? "done" : isCurrent ? "current" : "todo"}
              className="flex items-center gap-3 lg:w-16 lg:shrink-0 lg:flex-col lg:gap-1.5 lg:text-center"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border-2",
                  reached || isCurrent
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background",
                  isCurrent && "ring-4 ring-ring/30",
                )}
              >
                {reached ? <Check className="size-3" strokeWidth={3} /> : null}
              </span>
              <span
                className={cn(
                  "text-sm lg:text-xs",
                  reached || isCurrent ? "text-foreground" : "text-muted-foreground",
                  isCurrent && "font-medium",
                )}
              >
                {label}
                {reached ? <span className="sr-only"> (done)</span> : null}
              </span>
            </li>
          );
          if (last) return [item];
          return [
            item,
            <Connector
              key={`${step}-link`}
              filled={!stopped && i < current}
              snapped={snapped && i === PATH.length - 2}
            />,
          ];
        })}
      </ol>
      {stopped ? (
        <p className="text-sm" data-testid="progress-reason">
          <span className="font-medium">{statusLabel(status)}.</span>{" "}
          {status === "FAILED"
            ? (failureReasonText(failureReason ?? null) ?? "This case did not finish.")
            : "You withdrew this case."}
        </p>
      ) : null}
      {disputed ? (
        <p className="flex flex-wrap items-center gap-x-3 text-sm">
          <span className="font-medium text-case-disputed">Your provider billed again</span>
          {disputeHref ? (
            <a
              className="inline-flex min-h-11 items-center underline underline-offset-4"
              href={disputeHref}
            >
              Download dispute package
            </a>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
