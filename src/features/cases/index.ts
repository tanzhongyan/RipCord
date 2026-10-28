// Server API for cross-feature use (the mandate flow) and the spec 0006
// routes. No client component imports this barrel: chat and MCP reach the
// engine through tRPC, never through a direct import.
export {
  CALL_MAX_DURATION_MS,
  chooseMenuDigits,
  classifySpeaker,
  detectMenuPrompt,
  resolveCallDigits,
} from "./server/call";
export { generateCards } from "./server/cards";
export { type TransitionActor, type TransitionOpts, transition } from "./server/engine";
export { ToolError, type ToolErrorCode } from "./server/errors";
export { handleStepFailure } from "./server/executor";
export { processProviderReply } from "./server/replies";
