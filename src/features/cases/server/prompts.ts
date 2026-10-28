import { readFileSync } from "node:fs";

/** The in-app chat system prompt (spec 0004), stored beside this loader. */
export function loadAgentPrompt(): string {
  return readFileSync(new URL("./prompts/agent.md", import.meta.url), "utf8").trim();
}

/** The retention-defense coach prompt (spec 0005), stored beside this loader. */
export function loadRetentionPrompt(): string {
  return readFileSync(new URL("./prompts/retention.md", import.meta.url), "utf8").trim();
}

/** The notice-email body template (spec 0005). Tokens resolve at send time. */
export function loadNoticeEmailTemplate(): string {
  return readFileSync(new URL("./templates/notice-email.txt", import.meta.url), "utf8").trim();
}
