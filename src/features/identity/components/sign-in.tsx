"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "~/shared/components/ui/button";
import { DropdownMenuItem } from "~/shared/components/ui/dropdown-menu";
import { Input } from "~/shared/components/ui/input";
import { Label } from "~/shared/components/ui/label";
import { authClient } from "./auth-client";

const sentMessage = "If that email can sign in, we've sent a code.";

export function SignInForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const requestCode = async () => {
    if (pending) return;
    if (!email.trim()) {
      setError("Enter your email address.");
      return;
    }
    setPending(true);
    setError(null);
    const { error: sendError } = await authClient.emailOtp.sendVerificationOtp({
      email: email.trim(),
      type: "sign-in",
    });
    setPending(false);
    if (sendError) {
      setError("Could not send a code. Check the address and try again.");
      return;
    }
    setSent(true);
    toast.success("Code sent");
  };

  const sendCode = async (event: React.FormEvent) => {
    event.preventDefault();
    await requestCode();
  };

  const verifyCode = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the 6-digit code.");
      return;
    }
    setPending(true);
    setError(null);
    const { error: verifyError } = await authClient.signIn.emailOtp({
      email: email.trim(),
      otp: code.trim(),
    });
    if (verifyError) {
      setPending(false);
      setError("That code did not work. Check it and try again.");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  };

  const errorText = error ? (
    <p id="signin-error" role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-muted-foreground">
          {sent ? sentMessage : "We email you a 6-digit code. No password needed."}
        </p>
      </div>
      {!sent ? (
        <form onSubmit={sendCode} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="signin-email">Email address</Label>
            <Input
              id="signin-email"
              name="email"
              type="email"
              autoComplete="email"
              spellCheck={false}
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "signin-error" : undefined}
            />
            {errorText}
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? "Sending…" : "Send login code"}
          </Button>
        </form>
      ) : (
        <form onSubmit={verifyCode} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="signin-code">Login code for {email}</Label>
            <Input
              id="signin-code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              spellCheck={false}
              placeholder="123456"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "signin-error" : undefined}
            />
            {errorText}
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? "Checking…" : "Sign in"}
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                setSent(false);
                setCode("");
                setError(null);
              }}
            >
              Use a different email
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                setCode("");
                void requestCode();
              }}
            >
              Send a new code
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <Button
      type="button"
      variant="secondary"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await authClient.signOut();
        setPending(false);
        router.refresh();
      }}
      className="h-auto px-4 py-2 font-semibold"
    >
      {pending ? "Signing out…" : "Sign out"}
    </Button>
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
