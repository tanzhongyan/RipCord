import { randomUUID } from "node:crypto";

import type { BrowserContext } from "playwright/test";
import { describe, expect, it } from "vitest";

import { assertDevSignInAllowed, devSignIn } from "./dev-sign-in";

describe("E2E dev sign-in guard", () => {
  it("is off when NODE_ENV is production", () => {
    expect(() => assertDevSignInAllowed("production", "http://127.0.0.1:3000")).toThrow(
      "disabled in production",
    );
  });

  it("is off for a remote host", () => {
    expect(() => assertDevSignInAllowed("development", "https://ripcord.example")).toThrow(
      "local server",
    );
    expect(() => assertDevSignInAllowed("development", undefined)).toThrow("local server");
  });

  it("allows development and test against localhost", () => {
    expect(() => assertDevSignInAllowed("development", "http://localhost:3000")).not.toThrow();
    expect(() => assertDevSignInAllowed("test", "http://127.0.0.1:4100")).not.toThrow();
  });
});

describe("E2E dev sign-in", () => {
  it("gives each of several concurrent sign-ins of one email a session", async () => {
    const email = `${randomUUID()}@example.test`;
    const signIn = async () => {
      const added: unknown[] = [];
      const context = {
        addCookies: (cookies: unknown[]) => {
          added.push(...cookies);
          return Promise.resolve();
        },
      } as unknown as BrowserContext;
      await devSignIn(context, "http://127.0.0.1:3000", email);
      return added.length;
    };
    const counts = await Promise.all([signIn(), signIn(), signIn(), signIn()]);
    expect(counts).toEqual([1, 1, 1, 1]);
  });
});
