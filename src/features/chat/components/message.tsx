import { Lightbulb } from "lucide-react";
import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import { Button } from "~/shared/components/ui/button";
import { cn } from "~/shared/lib/utils";

// Raw HTML stays off (react-markdown's default) and no plugins are loaded.
// Links leave the app in a new tab; code blocks scroll inside the bubble.
const markdownComponents: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2"
    >
      {children}
    </a>
  ),
  pre: ({ children }) => (
    <pre className="max-w-full overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">
      {children}
    </pre>
  ),
};

function TypingIndicator() {
  return (
    <span role="status" aria-label="RipCord is typing" className="mt-1 inline-flex gap-1">
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          aria-hidden
          style={{ animationDelay: `${dot * 150}ms` }}
          className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-pulse"
        />
      ))}
    </span>
  );
}

export function Message({
  from,
  content,
  streaming = false,
}: {
  from: "user" | "assistant";
  content: string;
  streaming?: boolean;
}) {
  if (from === "user") {
    return (
      <div className="ml-auto max-w-[85%] rounded-xl bg-muted px-3 py-2 text-sm leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
        <span className="sr-only">You: </span>
        {content}
      </div>
    );
  }
  return (
    <div className="max-w-[68ch] min-w-0 text-sm leading-relaxed [overflow-wrap:anywhere]">
      <span className="sr-only">RipCord: </span>
      {content ? (
        <div
          className={cn(
            "[&>*+*]:mt-2 [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em] [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5",
          )}
        >
          <Markdown components={markdownComponents}>{content}</Markdown>
        </div>
      ) : null}
      {streaming ? <TypingIndicator /> : null}
    </div>
  );
}

export function PromptSuggestions({
  prompts,
  onPick,
}: {
  prompts: readonly string[];
  onPick: (prompt: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex max-w-[68ch] flex-col gap-1">
        <p className="flex items-center gap-2 text-base font-medium">
          <Lightbulb aria-hidden className="size-4 text-muted-foreground" />
          Ask RipCord to cancel a service
        </p>
        <p className="text-sm text-muted-foreground">
          It uses tools for every fact and asks before anything that costs money or needs approval.
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {prompts.map((prompt) => (
          <li key={prompt}>
            <Button
              type="button"
              variant="outline"
              onClick={() => onPick(prompt)}
              className="h-auto min-h-11 w-full justify-start bg-card px-3 py-2 text-left whitespace-normal [overflow-wrap:anywhere] sm:w-auto"
            >
              {prompt}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
