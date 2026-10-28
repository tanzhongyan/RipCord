import { describe, expect, it } from "vitest";

import { seedHolder, seedUser } from "~/features/identity/server/test-support";
import { db } from "~/server/db";
import { redact, redactPatterns, secretToken, storeSecret } from "~/server/vault";

describe("B3 Redact known values", () => {
  it("replaces a spaced, lower-case NRIC with its token", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const secret = await storeSecret(db, { holderId: holder.id, kind: "NRIC", value: "S1234567D" });
    const out = await redact(db, "my ic is s 1234567 d", holder.id);
    expect(out).toContain(secretToken("NRIC", secret.id));
    expect(out).not.toContain("1234567");
  });

  it("ignores spaces and dashes for PHONE and ACCOUNT_NO", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id, { phone: "+6598765432" });
    const account = await storeSecret(db, {
      holderId: holder.id,
      kind: "ACCOUNT_NO",
      value: "ACC-998877",
    });
    const out = await redact(db, "call +65 9876 5432 about ACC 998877", holder.id);
    expect(out).toContain("{{vault:PHONE:");
    expect(out).toContain(secretToken("ACCOUNT_NO", account.id));
    expect(out).not.toContain("9876");
    expect(out).not.toContain("998877");
  });

  it("matches other kinds case-insensitively but exactly", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const email = await storeSecret(db, {
      holderId: holder.id,
      kind: "EMAIL",
      value: "Dad@Example.com",
    });
    const out = await redact(db, "write to DAD@example.COM today", holder.id);
    expect(out).toContain(secretToken("EMAIL", email.id));
  });

  it("skips values shorter than 4 characters", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id, { phone: "+6598765433" });
    await storeSecret(db, { holderId: holder.id, kind: "DOB", value: "xy" });
    const out = await redact(db, "xy marks the spot, call +6598765433", holder.id);
    expect(out).toContain("xy marks the spot");
    expect(out).toContain("{{vault:PHONE:");
  });
});

describe("B4 Redact unknown values", () => {
  it("redacts an unknown NRIC by pattern", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const out = await redact(db, "ic T0123456G on file", holder.id);
    expect(out).toBe("ic [NRIC] on file");
  });

  it("redacts by pattern with no holder", () => {
    expect(redactPatterns("ic T0123456G, call 91234567")).toBe("ic [NRIC], call [PHONE]");
  });
});

describe("pattern table", () => {
  const cases: Array<[string, string, string]> = [
    ["nric S prefix", "S1234567D", "[NRIC]"],
    ["nric T prefix", "T0123456G", "[NRIC]"],
    ["nric F prefix", "F1234567N", "[NRIC]"],
    ["nric M prefix", "M1234567K", "[NRIC]"],
    ["phone bare 8", "call 91234567 now", "call [PHONE] now"],
    ["phone +65", "call +6591234567 now", "call [PHONE] now"],
    ["phone spaced", "call +65 8123 4567 now", "call [PHONE] now"],
    ["phone 6/9 start", "lines 61234567 and 98765432", "lines [PHONE] and [PHONE]"],
    ["email simple", "mail a@b.co", "mail [EMAIL]"],
    ["email plus", "mail a.b+1@example.com.sg ok", "mail [EMAIL] ok"],
    ["card spaced", "card 4111 1111 1111 1111", "card [CARD]"],
    ["card bare", "card 4111111111111111", "card [CARD]"],
    ["card dashed", "card 4111-1111-1111-1111", "card [CARD]"],
    // Near-misses: nothing redacted.
    ["7 digits, no letter", "postcode 1234567", "postcode 1234567"],
    ["nric short digit", "S123456D", "S123456D"],
    ["nric bad prefix", "X1234567D", "X1234567D"],
    ["nric lower", "s1234567d", "s1234567d"],
    ["phone 5 start", "code 51234567", "code 51234567"],
    ["phone 7 digits", "code 1234567", "code 1234567"],
    ["phone 9 digits", "code 912345678", "code 912345678"],
    ["not an email", "a string with no at-sign here", "a string with no at-sign here"],
    ["email no tld", "mail a@b", "mail a@b"],
    ["bad luhn 16", "num 4111111111111112", "num 4111111111111112"],
    ["short digits", "num 41111111", "num 41111111"],
  ];

  it.each(cases)("%s", (_name, input, expected) => {
    expect(redactPatterns(input)).toBe(expected);
  });

  it("leaves placeholder tokens untouched", () => {
    const token = "{{vault:NRIC:3f0c9a1b-7e2d-4a5b-8c6d-9e0f1a2b3c4d}}";
    expect(redactPatterns(`see ${token} and T0123456G`)).toBe(`see ${token} and [NRIC]`);
  });

  it("redacts every occurrence of a known secret", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const secret = await storeSecret(db, { holderId: holder.id, kind: "NRIC", value: "S1234567D" });
    const out = await redact(db, "S1234567D then s1234567d again", holder.id);
    expect(out).toBe(
      `${secretToken("NRIC", secret.id)} then ${secretToken("NRIC", secret.id)} again`,
    );
  });
});
