import { afterEach, describe, expect, it, vi } from "vitest";

import { SMS_RETRY_DELAYS_MS, sendSms, sendWithRetry, setSmsOverride } from "./sms";

afterEach(() => {
  setSmsOverride(null);
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
