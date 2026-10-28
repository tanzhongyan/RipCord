import twilio from "twilio";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SMS_RETRY_DELAYS_MS, sendSms, sendWithRetry, setSmsOverride } from "./sms";

vi.mock("twilio");

afterEach(() => {
  setSmsOverride(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("SMS sender", () => {
  it("logs to the console sink when Twilio is unset", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await sendSms("+6591234567", "Your RipCord code is: 123456");
    expect(log).toHaveBeenCalledWith("SMS to ****4567: Your RipCord code is: 123456");
  });

  it("uses the override when set", async () => {
    const seen: Array<{ to: string; body: string }> = [];
    setSmsOverride((to, body) => {
      seen.push({ to, body });
      return Promise.resolve();
    });
    await sendSms("+6591234567", "hello");
    expect(seen).toEqual([{ to: "+6591234567", body: "hello" }]);
  });
});

describe("sendWithRetry", () => {
  it("retries after 2s and 8s", () => {
    expect(SMS_RETRY_DELAYS_MS).toEqual([2000, 8000]);
  });

  it("sends once on success", async () => {
    let calls = 0;
    await sendWithRetry(() => {
      calls++;
    }, [2, 8]);
    expect(calls).toBe(1);
  });

  it("retries with back-off, then succeeds", async () => {
    let calls = 0;
    await sendWithRetry(() => {
      calls++;
      if (calls < 3) throw new Error("down");
    }, [5, 10]);
    expect(calls).toBe(3);
  });

  it("throws the last error after the delays run out", async () => {
    let calls = 0;
    await expect(
      sendWithRetry(() => {
        calls++;
        throw new Error(`down ${calls}`);
      }, [5, 10]),
    ).rejects.toThrow("down 3");
    expect(calls).toBe(3);
  });
});

describe("Twilio retry wiring", () => {
  const FROM = "+10000000000";

  async function loadSmsWithTwilio(create: ReturnType<typeof vi.fn>) {
    vi.resetModules();
    vi.stubEnv("TWILIO_ACCOUNT_SID", "ACtest");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "unit-test-only-not-a-real-token");
    vi.stubEnv("TWILIO_SMS_FROM", FROM);
    vi.mocked(twilio).mockReturnValue({ messages: { create } } as never);
    return import("./sms");
  }

  it("retries after a first-attempt Twilio failure, then succeeds", async () => {
    const create = vi.fn();
    create.mockRejectedValueOnce(new Error("twilio down"));
    create.mockResolvedValueOnce({ sid: "SM-test" });
    const sms = await loadSmsWithTwilio(create);
    vi.useFakeTimers();
    try {
      const pending = sms.sendSms("+6591234567", "Your RipCord code is: 123456");
      await vi.advanceTimersByTimeAsync(1999);
      expect(create).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith({
      to: "+6591234567",
      from: FROM,
      body: "Your RipCord code is: 123456",
    });
  });

  it("throws Could not send code when Twilio keeps failing", async () => {
    const create = vi.fn().mockRejectedValue(new Error("twilio down"));
    const sms = await loadSmsWithTwilio(create);
    vi.useFakeTimers();
    try {
      const pending = sms.sendSms("+6591234567", "code");
      const assertion = expect(pending).rejects.toThrow("Could not send code");
      await vi.advanceTimersByTimeAsync(2000);
      expect(create).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(7999);
      expect(create).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
    expect(create).toHaveBeenCalledTimes(3);
  });
});
