import { cn } from "~/shared/lib/utils";

/** Mark A (public/mark.svg) inline, so it inherits the text colour. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 14 120 54"
      fill="none"
      stroke="currentColor"
      strokeWidth="8"
      strokeLinecap="round"
      aria-hidden="true"
      className={cn("h-5 w-auto", className)}
    >
      <path d="M8 42H44C52 42 55 36 57 24" />
      <path d="M63 60C65 48 68 42 76 42H112" />
    </svg>
  );
}
