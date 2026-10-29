import { SignInForm } from "~/features/identity";
import { BrandMark } from "~/shared/components/brand-mark";
import { Toaster } from "~/shared/components/ui/sonner";

const trust = [
  "Acts only under a mandate you sign",
  "You approve every step before it runs",
  "Sign in with an emailed code, no password",
];

export default function SignInPage() {
  return (
    <div className="grid flex-1 md:grid-cols-2">
      {/* At md+ the left padding puts the content on the header's edge: max-w-5xl (64rem) plus px-4,
          measured against this half-width column (64rem / 2 = 32rem, less 1rem gutter). */}
      <section className="flex flex-col justify-center gap-4 bg-muted px-4 py-8 md:gap-8 md:py-12 md:pr-12 md:pl-[max(1rem,calc(100%-31rem))]">
        <BrandMark className="h-8 self-start text-primary md:h-16" />
        <div className="flex flex-col gap-2">
          <p className="text-xl font-semibold tracking-tight md:text-3xl">
            Cancel subscriptions without the runaround.
          </p>
          <ul className="hidden flex-col gap-2 text-sm text-muted-foreground md:flex">
            {trust.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>
      </section>
      <div className="flex items-center justify-center px-6 py-10 md:p-12">
        <div className="w-full max-w-sm">
          <SignInForm />
        </div>
      </div>
      {/* Only sign-in toasts; mounting it here keeps sonner out of every other page's bundle. */}
      <Toaster />
    </div>
  );
}
