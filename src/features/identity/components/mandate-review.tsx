"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "~/shared/components/ui/button";
import { Card, CardContent } from "~/shared/components/ui/card";
import { Input } from "~/shared/components/ui/input";
import { Label } from "~/shared/components/ui/label";
import { MANDATE_ACTION_LABELS } from "../schemas/mandate";
import type { MandateView } from "../server/mandate-flow";

function formatMoney(cents: number): string {
  return `S$${(cents / 100).toFixed(2)}`;
}

function formatDate(value: Date): string {
  return new Date(value).toLocaleDateString("en-SG", {
    timeZone: "Asia/Singapore",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

async function postAction(
  mandateId: string,
  action: "otp" | "sign" | "revoke" | "decline",
  body: Record<string, unknown>,
): Promise<{ ok: boolean; message: string | null }> {
  const response = await fetch(`/api/mandates/${mandateId}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return { ok: true, message: null };
  const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
  return { ok: false, message: parsed?.message ?? "Something went wrong" };
}

export function MandateReview({ view, token }: { view: MandateView; token: string | null }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [typedName, setTypedName] = useState("");
  const [allowLive, setAllowLive] = useState(false);
  const [fullName, setFullName] = useState("");
  const [nric, setNric] = useState("");
  const [pending, setPending] = useState(false);

  const sendCode = async () => {
    setPending(true);
    setError(null);
    const result = await postAction(view.mandateId, "otp", { token });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setCodeSent(true);
    setStatus("A 6-digit code is on its way by SMS.");
  };

  const sign = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await postAction(view.mandateId, "sign", {
      token,
      code,
      typedName,
      allowLive,
      ...(view.needsIdentity ? { fullName, nric } : {}),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  };

  const decline = async () => {
    if (!window.confirm("Decline this authorisation request?")) return;
    setPending(true);
    setError(null);
    const result = await postAction(view.mandateId, "decline", { token });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  };

  const revoke = async () => {
    if (!window.confirm("Revoke this authorisation? The cancellation stops.")) return;
    setPending(true);
    setError(null);
    const result = await postAction(view.mandateId, "revoke", { token });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          <Section title="Who is asking">
            <p className="font-medium">{view.requesterName}</p>
            <p className="text-sm text-muted-foreground">
              {view.sandbox ? "Sandbox — no real provider contact" : "Live"}
            </p>
          </Section>
          <Section title="What for">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Provider</dt>
              <dd className="font-medium">{view.providerName}</dd>
              <dt className="text-muted-foreground">Service type</dt>
              <dd>{view.serviceType ?? "—"}</dd>
              <dt className="text-muted-foreground">Account</dt>
              <dd>{view.accountHint ? `••••${view.accountHint}` : "—"}</dd>
              <dt className="text-muted-foreground">Maximum fee</dt>
              <dd>{formatMoney(view.maxFeeCents)}</dd>
            </dl>
            <h3 className="pt-1 text-sm font-medium">Allowed actions</h3>
            <ul className="list-disc pl-5 text-sm">
              {view.actions.map((action) => (
                <li key={action}>{MANDATE_ACTION_LABELS[action]}</li>
              ))}
            </ul>
          </Section>
          <Section title="How long it lasts">
            <p className="text-sm">
              <span className="text-muted-foreground">Expires</span>{" "}
              <span className="font-medium">{formatDate(view.expiresAt)}</span>
            </p>
          </Section>
        </CardContent>
      </Card>

      {view.status === "PENDING" ? (
        <Card>
          <CardContent className="flex flex-col gap-4 p-4">
            {!codeSent ? (
              <Button type="button" disabled={pending} onClick={sendCode} className={actionClass}>
                {pending ? "Sending…" : "Send code"}
              </Button>
            ) : (
              <form onSubmit={sign} className="flex flex-col gap-4">
                <Field label="SMS code" id="code">
                  <Input
                    id="code"
                    type="text"
                    required
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    className={inputClass}
                  />
                </Field>
                {view.needsIdentity ? (
                  <>
                    <Field label="Full name (as in your ID)" id="full-name">
                      <Input
                        id="full-name"
                        type="text"
                        required
                        autoComplete="name"
                        value={fullName}
                        onChange={(event) => setFullName(event.target.value)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="NRIC / FIN" id="nric">
                      <Input
                        id="nric"
                        type="text"
                        required
                        autoComplete="off"
                        value={nric}
                        onChange={(event) => setNric(event.target.value.toUpperCase())}
                        className={inputClass}
                      />
                    </Field>
                  </>
                ) : null}
                <Field label="Type your name as a signature" id="signature">
                  <Input
                    id="signature"
                    type="text"
                    required
                    autoComplete="name"
                    value={typedName}
                    onChange={(event) => setTypedName(event.target.value)}
                    className={inputClass}
                  />
                </Field>
                <label className="flex min-h-11 items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={allowLive}
                    onChange={(event) => setAllowLive(event.target.checked)}
                    className="mt-0.5 size-5 shrink-0 accent-primary"
                  />
                  Allow RipCord to contact the provider for real
                </label>
                <Button type="submit" disabled={pending} className={actionClass}>
                  {pending ? "Authorising…" : "I authorise"}
                </Button>
              </form>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={decline}
              className={actionClass}
            >
              Decline
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {view.status === "ACTIVE" ? (
        <Card>
          <CardContent className="flex flex-col gap-3 p-4">
            <p className="text-sm">This authorisation is active.</p>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={revoke}
              className={actionClass}
            >
              Revoke
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {view.status === "REVOKED" ? (
        <p className="text-sm">This authorisation was revoked.</p>
      ) : null}
      {view.status === "EXPIRED" ? <p className="text-sm">This authorisation expired.</p> : null}
      {view.status === "CONSUMED" ? (
        <p className="text-sm">This authorisation was used and is now closed.</p>
      ) : null}

      {status ? <p className="text-sm">{status}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const actionClass = "h-11 w-full px-4";
const inputClass = "h-11 px-3";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
