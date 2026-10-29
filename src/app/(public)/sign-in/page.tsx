import { SignInForm } from "~/features/identity";
import { BrandMark } from "~/shared/components/brand-mark";

const trust = [
  "Acts only under a mandate you sign",
  "You approve every step before it runs",
  "Sign in with an emailed code, no password",
];

export default function SignInPage() {
  return (
    <div className="grid flex-1 md:grid-cols-2">
      <section className="flex flex-col justify-center gap-4 bg-muted px-6 py-8 md:gap-8 md:p-12">
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
    </div>
  );
}
