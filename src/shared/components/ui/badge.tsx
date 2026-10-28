import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/shared/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "var(--case-draft)",
  DISCOVERY: "var(--case-discovery)",
  PRE_FLIGHT_AUDIT: "var(--case-pre-flight-audit)",
  AWAITING_MANDATE: "var(--case-awaiting-mandate)",
  CHANNEL_PLANNING: "var(--case-channel-planning)",
  EXECUTING: "var(--case-executing)",
  RECEIPT_ACQUISITION: "var(--case-receipt-acquisition)",
  AWAITING_VERIFICATION: "var(--case-awaiting-verification)",
  SUCCEEDED: "var(--case-succeeded)",
  FAILED: "var(--case-failed)",
  WITHDRAWN: "var(--case-withdrawn)",
  DISPUTED: "var(--case-disputed)",
};

/** Status badge: each `case_status` maps to one colour token in `globals.css`. */
function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "var(--case-draft)";
  return (
    <Badge variant="outline" style={{ borderColor: color, color }} data-status={status}>
      {status}
    </Badge>
  );
}

export { Badge, badgeVariants, StatusBadge };
