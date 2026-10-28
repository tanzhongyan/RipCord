import { describe, expect, it } from "vitest";

import { parseStreamMessage } from "./index";

describe("media-stream frames", () => {
  it("parses connected, start, media and stop frames", () => {
    expect(parseStreamMessage({ event: "connected" })).toEqual({ event: "connected" });
    expect(
      parseStreamMessage({ event: "start", start: { callSid: "CA1", streamSid: "MZ1" } }),
    ).toEqual({ event: "start", callSid: "CA1", streamSid: "MZ1" });
    expect(parseStreamMessage({ event: "media", media: { payload: "aGk=" } })).toEqual({
      event: "media",
      payload: "aGk=",
    });
    expect(parseStreamMessage({ event: "stop" })).toEqual({ event: "stop" });
  });

  it("treats malformed frames as other", () => {
    expect(parseStreamMessage(null)).toEqual({ event: "other" });
    expect(parseStreamMessage("hi")).toEqual({ event: "other" });
    expect(parseStreamMessage({ event: "start", start: {} })).toEqual({ event: "other" });
    expect(parseStreamMessage({ event: "media", media: {} })).toEqual({ event: "other" });
    expect(parseStreamMessage({ event: "mark" })).toEqual({ event: "other" });
  });
});
