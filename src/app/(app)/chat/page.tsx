import { ChatClient } from "~/features/chat";
import { api } from "~/trpc/server";
import { caseNamesFor } from "../cases/[id]/case-names";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ caseId?: string }>;
}) {
  const { caseId: rawCaseId } = await searchParams;
  const caseId = typeof rawCaseId === "string" ? rawCaseId : null;
  // The header names the attached case's provider. A case the user cannot read shows no name;
  // the chat itself still reports "Case not found" on send, as before.
  const providerName = caseId
    ? await api.cases.get({ caseId }).then(
        async (view) => (await caseNamesFor(caseId, view.case.status)).providerName,
        () => null,
      )
    : null;

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] min-w-0 flex-col md:h-dvh">
      <h1 className="sr-only">Chat</h1>
      <ChatClient caseId={caseId} providerName={providerName} />
    </div>
  );
}
