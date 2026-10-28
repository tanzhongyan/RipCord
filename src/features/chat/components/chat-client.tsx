"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "~/trpc/react";
import { chatEventSchema } from "../schemas/chat";

const DRAFT_KEY = "ripcord-chat-draft";

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

interface ToolLine {
  callId: string;
  name: string;
  status: "running" | "ok" | "error";
  detail?: string;
}

interface ConfirmCard {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  summary: string;
}

type AttachKind = "BILL" | "CONTRACT" | "SCREENSHOT";

function dollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

export function ChatClient({ caseId }: { caseId: string | null }) {
  const status = api.chat.status.useQuery();
  const attachDocument = api.chat.attachDocument.useMutation();
  const idCounter = useRef(1);
  const nextId = () => idCounter.current++;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [buffer, setBuffer] = useState("");
  const bufferRef = useRef("");
  const [tools, setTools] = useState<ToolLine[]>([]);
  const [confirm, setConfirm] = useState<ConfirmCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(() =>
    typeof window === "undefined" ? "" : (sessionStorage.getItem(DRAFT_KEY) ?? ""),
  );
  const [attachKind, setAttachKind] = useState<AttachKind>("BILL");
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activity = `${messages.length}:${buffer.length}:${tools.length}:${confirm?.callId ?? ""}:${error ?? ""}`;
  useEffect(() => {
    if (activity.length > 0) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [activity]);

  const appendBuffer = (text: string) => {
    bufferRef.current += text;
    setBuffer(bufferRef.current);
  };

  const flushBuffer = () => {
    const current = bufferRef.current;
    bufferRef.current = "";
    setBuffer("");
    if (current) {
      setMessages((prev) => [...prev, { id: nextId(), role: "assistant", content: current }]);
    }
  };

  const sendTurn = async (
    outgoing: Array<{ role: "user" | "assistant"; content: string }>,
    approvals?: Array<{ name: string; args: Record<string, unknown> }>,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: outgoing,
          ...(caseId ? { caseId } : {}),
          ...(approvals ? { approvals } : {}),
        }),
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
        setError(typeof body?.message === "string" ? body.message : "Chat failed. Try again.");
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let rest = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });
        const frames = rest.split("\n\n");
        rest = frames.pop() ?? "";
        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const parsed = chatEventSchema.safeParse(JSON.parse(line.slice("data: ".length)));
            if (!parsed.success) continue;
            const event = parsed.data;
            if (event.type === "token") {
              appendBuffer(event.text);
            } else if (event.type === "tool_call") {
              setTools((prev) => [
                ...prev,
                { callId: event.callId, name: event.name, status: "running" },
              ]);
            } else if (event.type === "tool_result") {
              setTools((prev) =>
                prev.map((line) =>
                  line.callId === event.callId
                    ? {
                        ...line,
                        status: event.ok ? "ok" : "error",
                        detail: event.ok ? undefined : (event.message ?? event.code),
                      }
                    : line,
                ),
              );
            } else if (event.type === "confirm_request") {
              flushBuffer();
              setConfirm({
                callId: event.callId,
                name: event.name,
                args: event.args,
                summary: event.summary,
              });
            } else if (event.type === "error") {
              setError(event.message);
            } else {
              flushBuffer();
              status.refetch();
            }
          }
        }
      }
    } catch {
      setError("The connection dropped. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const send = () => {
    const content = draft.trim();
    if (!content || busy) return;
    const userMessage: ChatMessage = { id: nextId(), role: "user", content };
    const outgoing = [...messages, userMessage].map(({ role, content: text }) => ({
      role,
      content: text,
    }));
    setMessages((prev) => [...prev, userMessage]);
    setDraft("");
    sessionStorage.removeItem(DRAFT_KEY);
    void sendTurn(outgoing);
  };

  const answerConfirm = (approved: boolean) => {
    if (!confirm) return;
    const card = confirm;
    setConfirm(null);
    if (!approved) return;
    const outgoing = messages.map(({ role, content }) => ({ role, content }));
    void sendTurn(outgoing, [{ name: card.name, args: card.args }]);
  };

  const onFile = async (file: File) => {
    if (!caseId) {
      setAttachError("Open a case first: files attach to a case.");
      return;
    }
    setAttachBusy(true);
    setAttachError(null);
    try {
      const { documentId, uploadUrl } = await attachDocument.mutateAsync({
        caseId,
        kind: attachKind,
        contentType: file.type || "application/pdf",
        contentLength: file.size,
      });
      const put = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "content-type": file.type || "application/pdf" },
        body: file,
      });
      if (!put.ok) throw new Error(`upload failed with ${put.status}`);
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", content: `Attached ${attachKind} document ${documentId}.` },
      ]);
    } catch (unknownError) {
      setAttachError(
        unknownError instanceof Error ? unknownError.message : "Upload failed. Try again.",
      );
    } finally {
      setAttachBusy(false);
    }
  };

  return (
    <div className="flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between gap-4 text-sm">
        <p>{caseId ? `Case ${caseId.slice(0, 8)}…` : "No case selected"}</p>
        <p>
          {status.data ? (
            <>
              {status.data.credits} credits · AI {dollars(status.data.aiSpentMicros)} of{" "}
              {dollars(status.data.aiBudgetMicros)}
            </>
          ) : (
            "Loading allowance…"
          )}
        </p>
      </div>
      <div
        ref={scrollRef}
        className="flex max-h-[50vh] min-h-64 flex-col gap-3 overflow-y-auto rounded-lg border border-slate-700 p-4"
      >
        {messages.length === 0 && !buffer ? (
          <p className="text-sm text-slate-300">
            Ask RipCord to cancel a service. It uses tools for every fact and asks before anything
            that costs money or needs approval.
          </p>
        ) : null}
        {messages.map((message) => (
          <p key={message.id} className="text-sm">
            <span className="font-semibold">{message.role === "user" ? "You" : "RipCord"}: </span>
            {message.content}
          </p>
        ))}
        {buffer ? (
          <p className="text-sm">
            <span className="font-semibold">RipCord: </span>
            {buffer}
          </p>
        ) : null}
        {tools.map((line) => (
          <p key={line.callId} className="text-sm text-slate-300">
            ▸ {line.name} …{" "}
            {line.status === "running" ? "running" : line.status === "ok" ? "done" : "failed"}
            {line.detail ? ` (${line.detail})` : ""}
          </p>
        ))}
        {confirm ? (
          <div className="flex flex-col gap-2 rounded-lg border border-slate-600 p-3">
            <p className="text-sm font-semibold">Confirm: {confirm.name}</p>
            <p className="text-sm">{confirm.summary}</p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => answerConfirm(true)}
                className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-50"
              >
                Confirm
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => answerConfirm(false)}
                className="rounded-lg border border-slate-600 px-4 py-2 text-sm disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          aria-label="Chat message"
          value={draft}
          disabled={busy}
          onChange={(event) => {
            setDraft(event.target.value);
            sessionStorage.setItem(DRAFT_KEY, event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") send();
          }}
          placeholder="Type a message…"
          className="flex-1 rounded-lg border border-slate-600 bg-slate-800 px-4 py-2"
        />
        <button
          type="button"
          disabled={busy || !draft.trim()}
          onClick={send}
          className="rounded-lg bg-slate-100 px-4 py-2 font-semibold text-slate-900 disabled:opacity-50"
        >
          {busy ? "Working…" : "Send"}
        </button>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <label htmlFor="chat-kind">Attach</label>
        <select
          id="chat-kind"
          value={attachKind}
          disabled={attachBusy || !caseId}
          onChange={(event) => setAttachKind(event.target.value as AttachKind)}
          className="rounded-lg border border-slate-600 bg-slate-800 px-2 py-1"
        >
          <option value="BILL">Bill</option>
          <option value="CONTRACT">Contract</option>
          <option value="SCREENSHOT">Screenshot</option>
        </select>
        <input
          type="file"
          aria-label="Attach a file"
          accept="application/pdf,image/png,image/jpeg"
          disabled={attachBusy || !caseId}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void onFile(file);
          }}
        />
        {attachBusy ? <span>Uploading…</span> : null}
        {attachError ? (
          <span role="alert" className="text-red-300">
            {attachError}
          </span>
        ) : null}
        {!caseId ? <span className="text-slate-300">Files attach to a case.</span> : null}
      </div>
    </div>
  );
}
