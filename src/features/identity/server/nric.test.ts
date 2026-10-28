import { describe, expect, it } from "vitest";

import { isValidNric } from "./nric";

describe("NRIC checksum", () => {
  it.each(["S1234567D", "T0123456G", "T1234567J", "F1234567N", "F9999999M", "M5012345J"])(
    "accepts %s",
    (value) => {
      expect(isValidNric(value)).toBe(true);
    },
  );

  it.each(["S1234567A", "T1234567D", "F1234567X", "M5012345M"])(
    "rejects a bad check letter: %s",
    (value) => {
      expect(isValidNric(value)).toBe(false);
    },
  );

  it.each(["", "S123456", "S12345678D", "s1234567d", "A1234567D", "S1234567d", "S12345 7D"])(
    "rejects a bad shape: %s",
    (value) => {
      expect(isValidNric(value)).toBe(false);
    },
  );
});
