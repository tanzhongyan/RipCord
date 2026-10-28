import { readFileSync } from "node:fs";

/** The in-app chat system prompt (spec 0004), stored beside this loader. */
export function loadAgentPrompt(): string {
  return readFileSync(new URL("./prompts/agent.md", import.meta.url), "utf8").trim();
}
