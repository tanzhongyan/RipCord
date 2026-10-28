import { describe, expect, it } from "vitest";

import { loadAgentPrompt } from "./prompts";

describe("agent system prompt", () => {
  it("states the six spec rules", () => {
    const prompt = loadAgentPrompt();
    expect(prompt.startsWith("You are RipCord,")).toBe(true);
    expect(prompt).toContain("Use tools for every fact about providers, cases and money");
    expect(prompt).toContain("{{vault:NRIC:...}}");
    expect(prompt).toContain("this uses one credit; say so and ask before calling start-case");
    expect(prompt).toContain("Never accept an offer for the user");
    expect(prompt).toContain("Before any tool marked confirm");
    expect(prompt).toContain("Be brief and plain");
  });
});
