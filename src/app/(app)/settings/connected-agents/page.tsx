import { ConnectedAgentsList } from "~/features/identity";

export const dynamic = "force-dynamic";

export default function ConnectedAgentsPage() {
  return (
    <div className="flex flex-1 flex-col items-center bg-slate-950 px-4 py-16 text-white">
      <div className="flex w-full max-w-lg flex-col gap-8">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold">Connected agents</h1>
          <p className="text-sm">
            Assistants you connected over MCP. Revoking removes their access at once.
          </p>
        </div>
        <ConnectedAgentsList />
      </div>
    </div>
  );
}
