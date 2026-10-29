import { ConnectedAgentsList } from "~/features/identity";

export const dynamic = "force-dynamic";

export default function ConnectedAgentsPage() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Connected agents</h2>
        <p className="text-sm text-muted-foreground">
          Assistants you connected over MCP. Revoking removes their access at once.
        </p>
      </div>
      <ConnectedAgentsList />
    </div>
  );
}
