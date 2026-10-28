import { describe, expect, it } from "vitest";

import { loadAgentPrompt, loadNoticeEmailTemplate, loadRetentionPrompt } from "./prompts";

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

describe("retention defense prompt", () => {
  it("matches the spec text verbatim", () => {
    const prompt = loadRetentionPrompt();
    expect(prompt.startsWith("You coach a person who is cancelling a service.")).toBe(true);
    expect(prompt).toContain("Return 1 to 3 cards as JSON.");
    expect(prompt).toContain("Decline every discount, pause, downgrade, free month");
    expect(prompt).toContain("Always ask for the termination reference number");
    expect(prompt).toContain("Placeholders like {{vault:...}} stay as they are.");
    expect(prompt).toContain("Ask the rep to confirm this in writing.");
  });
});

describe("notice email template", () => {
  it("matches the spec text verbatim", () => {
    const template = loadNoticeEmailTemplate();
    expect(template.startsWith("Dear {provider.name} team,")).toBe(true);
    expect(template).toContain("I am writing on behalf of {{vault:FULL_NAME}}");
    expect(template).toContain("Account number: {{vault:ACCOUNT_NO}}");
    expect(template).toContain("Service: {service_label}");
    expect(template).toContain("Requested termination date: {requested_date}");
    expect(template).toContain("A signed letter of authorisation is attached.");
    expect(template).toContain("{delegate_display_name}, authorised representative");
    expect(template).toContain("Sent with RipCord (mandate {mandate_id})");
  });
});
