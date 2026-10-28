// Server API for the MCP and chat routes, plus the chat UI for the page.
// Client components never import this barrel (its server graph would enter
// the client bundle); they import relatively inside the feature.
export { ChatClient } from "./components/chat-client";
export { type ChatEvent, chatRequestSchema } from "./schemas/chat";
export { loadChatCaller, resolveChatContext, runAgentLoop } from "./server/agent";
export {
  isDevBypass,
  mcpAuthMode,
  mcpProtectedResourceMetadata,
  mcpServer,
  setMcpAuthStub,
} from "./server/mcp";
