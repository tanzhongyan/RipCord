import { ChatClient } from "~/features/chat";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ caseId?: string }>;
}) {
  const { caseId } = await searchParams;

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] min-w-0 flex-col md:h-dvh">
      <h1 className="sr-only">Chat</h1>
      <ChatClient caseId={typeof caseId === "string" ? caseId : null} />
    </div>
  );
}
