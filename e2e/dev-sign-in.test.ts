import { describe, expect, it } from "vitest";

import { assertDevSignInAllowed } from "./dev-sign-in";

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
