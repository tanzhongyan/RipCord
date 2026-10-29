import { cn } from "~/shared/lib/utils";

/**
 * Signature element (DESIGN.md): a straight line that breaks with the mark A curl.
 * The right half is cut and drawn in `text-cut`. Decorative, so hidden from assistive tech.
 */
export function RopeDivider({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("flex items-center", className)}>
      <div className="h-0.5 flex-1 rounded-full bg-muted-foreground/40" />
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 14 120 54"
        fill="none"
        aria-hidden="true"
        strokeWidth="8"
        strokeLinecap="round"
        className="h-8 w-auto shrink-0"
      >
        <path d="M8 42H44C52 42 55 36 57 24" stroke="currentColor" className="text-foreground" />
        <path d="M63 60C65 48 68 42 76 42H112" stroke="currentColor" className="text-cut" />
      </svg>
      <div className="h-0.5 flex-1 rounded-full bg-muted-foreground/40" />
    </div>
  );
}
