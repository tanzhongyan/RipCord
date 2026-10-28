// Server API for cross-feature use (the mandate flow) and the spec 0006
// routes. No client component imports this barrel: chat and MCP reach the
// engine through tRPC, never through a direct import.
export { type TransitionActor, type TransitionOpts, transition } from "./server/engine";
export { ToolError, type ToolErrorCode } from "./server/errors";
