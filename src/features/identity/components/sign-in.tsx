"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DropdownMenuItem } from "~/shared/components/ui/dropdown-menu";
import { authClient } from "./auth-client";

export function SignInForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const sendCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { error: sendError } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "sign-in",
    });
    setPending(false);
    if (sendError) {
      setError("Could not send a code. Check the address and try again.");
      return;
    }
    setSent(true);
  };

  const verifyCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { error: verifyError } = await authClient.signIn.emailOtp({ email, otp: code });
    setPending(false);
    if (verifyError) {
      setError("That code did not work. Check it and try again.");
      return;
    }
    router.refresh();
  };

  return (
    <div className="flex w-full max-w-sm flex-col gap-4">
      <h2 className="text-xl font-bold">Sign in</h2>
      {!sent ? (
        <form onSubmit={sendCode} className="flex flex-col gap-2">
          <label className="text-sm" htmlFor="signin-email">
            Email address
          </label>
          <input
            id="signin-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2"
          />
          <button
            type="submit"
            disabled={pending || !email}
            className="rounded-lg bg-slate-100 px-4 py-2 font-semibold text-slate-900 disabled:opacity-50"
          >
            {pending ? "Sending…" : "Send login code"}
          </button>
        </form>
      ) : (
        <form onSubmit={verifyCode} className="flex flex-col gap-2">
          <p className="text-sm">A 6-digit code is on its way to {email}.</p>
          <label className="text-sm" htmlFor="signin-code">
            Login code
          </label>
          <input
            id="signin-code"
            type="text"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2"
          />
          <button
            type="submit"
            disabled={pending || code.length !== 6}
            className="rounded-lg bg-slate-100 px-4 py-2 font-semibold text-slate-900 disabled:opacity-50"
          >
            {pending ? "Checking…" : "Sign in"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setSent(false);
              setCode("");
            }}
            className="text-sm underline"
          >
            Use a different address
          </button>
        </form>
      )}
      {error ? (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await authClient.signOut();
        setPending(false);
        router.refresh();
      }}
      className="rounded-lg bg-slate-100 px-4 py-2 font-semibold text-slate-900 disabled:opacity-50"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}

/** Sign-out entry for the app sidebar user menu. Ends the session, then returns to /sign-in. */
export function SignOutMenuItem() {
  const router = useRouter();
  return (
    <DropdownMenuItem
      onClick={async () => {
        await authClient.signOut();
        router.push("/sign-in");
        router.refresh();
      }}
    >
      Sign out
    </DropdownMenuItem>
  );
}
