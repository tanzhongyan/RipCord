import { describe, expect, it, vi } from "vitest";

import { logger } from "~/server/logger";

describe("server logger", () => {
  it("redacts PII patterns on every level", () => {
    const spies = {
      debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
    try {
      logger.debug("ic S1234567D");
      logger.info("call +6591234567");
      logger.warn("mail dad@example.com");
      logger.error("card 4111111111111111");
      expect(spies.debug).toHaveBeenCalledWith("ic [NRIC]");
      expect(spies.info).toHaveBeenCalledWith("call [PHONE]");
      expect(spies.warn).toHaveBeenCalledWith("mail [EMAIL]");
      expect(spies.error).toHaveBeenCalledWith("card [CARD]");
    } finally {
      for (const spy of Object.values(spies)) spy.mockRestore();
    }
  });

  it("scrubs Error messages and stacks", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failure = new Error("validation failed for S1234567D");
      failure.stack = "Error: validation failed for S1234567D\n    at test";
      logger.error("request failed", failure);
      const logged = error.mock.calls[0]?.[1] as Error;
      expect(logged.message).toBe("validation failed for [NRIC]");
      expect(logged.stack).not.toContain("1234567");
    } finally {
      error.mockRestore();
    }
  });

  it("passes non-string values through", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      logger.info("counts", { deleted: 3 });
      expect(info).toHaveBeenCalledWith("counts", { deleted: 3 });
    } finally {
      info.mockRestore();
    }
  });
});
