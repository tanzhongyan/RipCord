import { ChatClient } from "~/features/chat";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ caseId?: string }>;
}) {
  const { caseId } = await searchParams;

  return (
    <div className="flex flex-1 flex-col items-center bg-slate-950 px-4 py-16 text-white">
      <div className="flex w-full max-w-2xl flex-col items-center gap-8">
        <h1 className="text-3xl font-bold">Chat</h1>
        <ChatClient caseId={typeof caseId === "string" ? caseId : null} />
      </div>
    </div>
  );
}
