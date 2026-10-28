"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
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
    <div className="flex w-full max-w-lg flex-col gap-6">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="font-semibold">Requested by</dt>
        <dd>{view.requesterName}</dd>
        <dt className="font-semibold">Provider</dt>
        <dd>{view.providerName}</dd>
        <dt className="font-semibold">Service type</dt>
        <dd>{view.serviceType ?? "—"}</dd>
        <dt className="font-semibold">Account</dt>
        <dd>{view.accountHint ? `••••${view.accountHint}` : "—"}</dd>
        <dt className="font-semibold">Maximum fee</dt>
        <dd>{formatMoney(view.maxFeeCents)}</dd>
        <dt className="font-semibold">Expires</dt>
        <dd>{formatDate(view.expiresAt)}</dd>
        <dt className="font-semibold">Mode</dt>
        <dd>{view.sandbox ? "Sandbox — no real provider contact" : "Live"}</dd>
      </dl>

      <div>
        <h2 className="font-semibold">Allowed actions</h2>
        <ul className="list-disc pl-6 text-sm">
          {view.actions.map((action) => (
            <li key={action}>{MANDATE_ACTION_LABELS[action]}</li>
          ))}
        </ul>
      </div>

      {view.status === "PENDING" ? (
        <div className="flex flex-col gap-4">
          {!codeSent ? (
            <button
              type="button"
              disabled={pending}
              onClick={sendCode}
              className="rounded-lg bg-slate-100 px-4 py-2 font-semibold text-slate-900 disabled:opacity-50"
            >
              {pending ? "Sending…" : "Send code"}
            </button>
          ) : (
            <form onSubmit={sign} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm">
                SMS code
                <input
                  type="text"
                  required
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2"
                />
              </label>
              {view.needsIdentity ? (
                <>
                  <label className="flex flex-col gap-1 text-sm">
                    Full name (as in your ID)
                    <input
                      type="text"
                      required
                      autoComplete="name"
                      value={fullName}
                      onChange={(event) => setFullName(event.target.value)}
                      className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    NRIC / FIN
                    <input
                      type="text"
                      required
                      autoComplete="off"
                      value={nric}
                      onChange={(event) => setNric(event.target.value.toUpperCase())}
                      className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2"
                    />
                  </label>
                </>
              ) : null}
              <label className="flex flex-col gap-1 text-sm">
                Type your name as a signature
                <input
                  type="text"
                  required
                  autoComplete="name"
                  value={typedName}
                  onChange={(event) => setTypedName(event.target.value)}
                  className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2"
                />
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allowLive}
                  onChange={(event) => setAllowLive(event.target.checked)}
                />
                Allow RipCord to contact the provider for real
              </label>
              <button
                type="submit"
                disabled={pending}
                className="rounded-lg bg-slate-100 px-4 py-2 font-semibold text-slate-900 disabled:opacity-50"
              >
                {pending ? "Authorising…" : "I authorise"}
              </button>
            </form>
          )}
          <button type="button" disabled={pending} onClick={decline} className="text-sm underline">
            Decline
          </button>
        </div>
      ) : null}

      {view.status === "ACTIVE" ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm">This authorisation is active.</p>
          <button type="button" disabled={pending} onClick={revoke} className="text-sm underline">
            Revoke
          </button>
        </div>
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
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
