"use client";

import { Paperclip, SendHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/shared/components/ui/button";
import { Textarea } from "~/shared/components/ui/textarea";
import { api } from "~/trpc/react";
import { chatEventSchema } from "../schemas/chat";
import { Message, PromptSuggestions } from "./message";
import { ConfirmCard, type ConfirmRequest, ToolCard, type ToolLine } from "./tool-card";

const DRAFT_KEY = "ripcord-chat-draft";

const SUGGESTIONS = [
  "Cancel my Singtel fibre plan",
  "Can I leave my gym contract early?",
  "Check my phone bill for charges I do not recognise",
] as const;

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
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
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(() =>
    typeof window === "undefined" ? "" : (sessionStorage.getItem(DRAFT_KEY) ?? ""),
  );
  const [attachKind, setAttachKind] = useState<AttachKind>("BILL");
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const updateDraft = (value: string) => {
    setDraft(value);
    sessionStorage.setItem(DRAFT_KEY, value);
  };

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
        const body = (await response.json().catch(() => null)) as {
          message?: unknown;
        } | null;
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
        {
          id: nextId(),
          role: "user",
          content: `Attached ${attachKind} document ${documentId}.`,
        },
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-4 border-b px-4 py-2 text-xs text-muted-foreground">
        <p className="min-w-0 truncate">
          {caseId ? `Case ${caseId.slice(0, 8)}…` : "No case selected"}
        </p>
        <p className="shrink-0 font-mono">
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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-4">
          {messages.length === 0 && !buffer ? (
            <PromptSuggestions
              prompts={SUGGESTIONS}
              onPick={(prompt) => {
                updateDraft(prompt);
                composerRef.current?.focus();
              }}
            />
          ) : null}
          {messages.map((message) => (
            <Message key={message.id} from={message.role} content={message.content} />
          ))}
          {buffer || (busy && !confirm) ? (
            <Message from="assistant" content={buffer} streaming />
          ) : null}
          {tools.map((line) => (
            <ToolCard key={line.callId} line={line} />
          ))}
          {confirm ? <ConfirmCard card={confirm} busy={busy} onAnswer={answerConfirm} /> : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </div>
      <div className="sticky bottom-0 border-t bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-2">
          <div className="flex items-end gap-2">
            <Textarea
              ref={composerRef}
              aria-label="Chat message"
              rows={1}
              value={draft}
              onChange={(event) => updateDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
              placeholder="Type a message…"
              className="max-h-40 min-h-11 flex-1 resize-none text-base md:text-base"
            />
            <Button disabled={busy || !draft.trim()} onClick={send} className="h-11 px-4 md:h-11">
              <SendHorizontal aria-hidden />
              {busy ? "Working…" : "Send"}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label htmlFor="chat-kind" className="text-muted-foreground">
              Attach as
            </label>
            <select
              id="chat-kind"
              value={attachKind}
              disabled={attachBusy || !caseId}
              onChange={(event) => setAttachKind(event.target.value as AttachKind)}
              className="h-11 rounded-lg border border-input bg-transparent px-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 md:h-9 md:text-sm dark:bg-input/30"
            >
              <option value="BILL">Bill</option>
              <option value="CONTRACT">Contract</option>
              <option value="SCREENSHOT">Screenshot</option>
            </select>
            <input
              id="chat-file"
              type="file"
              className="peer sr-only"
              accept="application/pdf,image/png,image/jpeg"
              disabled={attachBusy || !caseId}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void onFile(file);
              }}
            />
            <label
              htmlFor="chat-file"
              className="inline-flex h-11 cursor-pointer items-center gap-1.5 rounded-lg border border-input px-3 transition-colors hover:bg-muted peer-focus-visible:border-ring peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 md:h-9"
            >
              <Paperclip aria-hidden className="size-4" />
              Attach a file
            </label>
            {attachBusy ? <span>Uploading…</span> : null}
            {attachError ? (
              <span role="alert" className="text-destructive">
                {attachError}
              </span>
            ) : null}
            {!caseId ? (
              <span className="text-muted-foreground">Files attach to a case.</span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
