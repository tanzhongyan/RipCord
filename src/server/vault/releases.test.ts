import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  seedAccountSecret,
  seedCase,
  seedChannel,
  seedHolder,
  seedMandate,
  seedProvider,
  seedStep,
  seedUser,
} from "~/features/identity/server/test-support";
import { db } from "~/server/db";
import { auditLogs, caseSteps, vaultReleases } from "~/server/db/schema";
import { isSandboxAddress, secretToken, storeSecret, VaultReleaseError } from "~/server/vault";
import { resolveTokens } from "~/server/vault/releases";

async function seedRelease(
  input: {
    caseStatus?: "EXECUTING" | "DISCOVERY";
    mandateStatus?: "ACTIVE" | "PENDING";
    mandateExpired?: boolean;
    channelOverrides?: Record<string, unknown>;
    approved?: boolean;
    sandbox?: boolean;
  } = {},
) {
  const user = await seedUser();
  const provider = await seedProvider();
  const holder = await seedHolder(user.id);
  const nric = await storeSecret(db, { holderId: holder.id, kind: "NRIC", value: "S1234567D" });
  const name = await storeSecret(db, {
    holderId: holder.id,
    kind: "FULL_NAME",
    value: "Tan Ah Kow",
  });
  const channel = await seedChannel(provider.id, {
    address: input.sandbox === false ? "cancel@singtel.com" : "cancel@provider.test",
    ...(input.channelOverrides ?? {}),
  });
  const c = await seedCase({
    ownerId: user.id,
    holderId: holder.id,
    providerId: provider.id,
    status: input.caseStatus ?? "EXECUTING",
  });
  if (input.sandbox === false) {
    await db.execute(sql`update cases set sandbox = false where id = ${c.id}`);
  }
  const account = await seedAccountSecret(holder.id);
  const mandate = await seedMandate({
    caseId: c.id,
    holderId: holder.id,
    providerId: provider.id,
    serviceSecretId: account.id,
    delegateUserId: user.id,
    status: input.mandateStatus ?? "ACTIVE",
  });
  if (input.mandateExpired) {
    await db.execute(
      sql`update mandates set expires_at = now() - interval '1 day' where id = ${mandate.id}`,
    );
  }
  const step = await seedStep(c.id, {
    approvedByUserId: input.approved === false ? null : user.id,
    approvedAt: input.approved === false ? null : new Date(),
  });
  const ctx = {
    caseId: c.id,
    stepId: step.id,
    mandateId: mandate.id,
    providerChannelId: channel.id,
  };
  return { user, holder, nric, name, channel, c, mandate, step, ctx };
}

async function releasesFor(stepId: string) {
  return db.select().from(vaultReleases).where(eq(vaultReleases.stepId, stepId));
}

async function stepStatus(stepId: string) {
  const [row] = await db.select().from(caseSteps).where(eq(caseSteps.id, stepId)).limit(1);
  return row?.status;
}

describe("B5 Release denied", () => {
  it("denies an unverified destination, writes nothing, fails the step", async () => {
    const { nric, step, ctx } = await seedRelease({
      channelOverrides: { isVerifiedDestination: false },
    });
    const text = `ic ${secretToken("NRIC", nric.id)}`;
    const error = await resolveTokens(db, text, ctx).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(VaultReleaseError);
    expect((error as VaultReleaseError).code).toBe("VAULT_RELEASE_DENIED");
    expect(await releasesFor(step.id)).toHaveLength(0);
    expect(await stepStatus(step.id)).toBe("FAILED");
  });
});

describe("B6 Release approved", () => {
  it("writes one release and one audit row per secret, with approval on the NRIC", async () => {
    const { nric, name, step, ctx } = await seedRelease();
    const text = `ic ${secretToken("NRIC", nric.id)} name ${secretToken("FULL_NAME", name.id)}`;
    const out = await resolveTokens(db, text, ctx);
    expect(out).toBe("ic S1234567D name Tan Ah Kow");

    const releases = await releasesFor(step.id);
    expect(releases).toHaveLength(2);
    const nricRelease = releases.find((row) => row.secretId === nric.id);
    const nameRelease = releases.find((row) => row.secretId === name.id);
    expect(nricRelease?.holderApprovedAt).toBeInstanceOf(Date);
    expect(nameRelease?.holderApprovedAt).toBeNull();

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.caseId, ctx.caseId));
    const releaseAudits = audits.filter((row) => row.action === "VAULT_RELEASE");
    expect(releaseAudits).toHaveLength(2);
    expect(await stepStatus(step.id)).toBe("RUNNING");
  });
});

describe("release rules", () => {
  it("denies when the case is not EXECUTING", async () => {
    const { nric, step, ctx } = await seedRelease({ caseStatus: "DISCOVERY" });
    await expect(resolveTokens(db, secretToken("NRIC", nric.id), ctx)).rejects.toMatchObject({
      code: "VAULT_RELEASE_DENIED",
    });
    expect(await stepStatus(step.id)).toBe("FAILED");
  });

  it("denies when the mandate is not ACTIVE", async () => {
    const { nric, ctx } = await seedRelease({ mandateStatus: "PENDING" });
    await expect(resolveTokens(db, secretToken("NRIC", nric.id), ctx)).rejects.toMatchObject({
      code: "VAULT_RELEASE_DENIED",
    });
  });

  it("denies when the mandate has expired", async () => {
    const { nric, ctx } = await seedRelease({ mandateExpired: true });
    await expect(resolveTokens(db, secretToken("NRIC", nric.id), ctx)).rejects.toMatchObject({
      code: "VAULT_RELEASE_DENIED",
    });
  });

  it("denies a channel on another provider", async () => {
    const other = await seedProvider();
    const { nric, ctx } = await seedRelease({
      channelOverrides: { providerId: other.id },
    });
    await expect(resolveTokens(db, secretToken("NRIC", nric.id), ctx)).rejects.toMatchObject({
      code: "VAULT_RELEASE_DENIED",
    });
  });

  it("denies a kind the channel did not ask for", async () => {
    const { nric, ctx } = await seedRelease({
      channelOverrides: { requiredSecrets: ["FULL_NAME"] },
    });
    await expect(resolveTokens(db, secretToken("NRIC", nric.id), ctx)).rejects.toMatchObject({
      code: "VAULT_RELEASE_DENIED",
    });
  });

  it("denies a sensitive kind without step approval, but allows a name", async () => {
    const denied = await seedRelease({ approved: false });
    await expect(
      resolveTokens(db, secretToken("NRIC", denied.nric.id), denied.ctx),
    ).rejects.toMatchObject({ code: "VAULT_RELEASE_DENIED" });

    const allowed = await seedRelease({ approved: false });
    const out = await resolveTokens(db, secretToken("FULL_NAME", allowed.name.id), allowed.ctx);
    expect(out).toBe("Tan Ah Kow");
  });

  it("blocks a sandbox case from a real destination", async () => {
    const { nric, step, ctx } = await seedRelease({
      channelOverrides: { address: "cancel@singtel.com" },
    });
    await expect(resolveTokens(db, secretToken("NRIC", nric.id), ctx)).rejects.toMatchObject({
      code: "SANDBOX_DESTINATION_BLOCKED",
    });
    expect(await releasesFor(step.id)).toHaveLength(0);
    expect(await stepStatus(step.id)).toBe("FAILED");
  });

  it("allows a live case to a real destination", async () => {
    const { nric, ctx } = await seedRelease({ sandbox: false });
    const out = await resolveTokens(db, secretToken("NRIC", nric.id), ctx);
    expect(out).toBe("S1234567D");
  });

  it("denies a token whose kind does not match the secret", async () => {
    const { nric, ctx } = await seedRelease();
    await expect(resolveTokens(db, secretToken("EMAIL", nric.id), ctx)).rejects.toMatchObject({
      code: "VAULT_RELEASE_DENIED",
    });
  });

  it("denies a token for another holder's secret", async () => {
    const first = await seedRelease();
    const stranger = await seedUser();
    const strangerHolder = await seedHolder(stranger.id);
    const strangerNric = await storeSecret(db, {
      holderId: strangerHolder.id,
      kind: "NRIC",
      value: "S7654321F",
    });
    await expect(
      resolveTokens(db, secretToken("NRIC", strangerNric.id), first.ctx),
    ).rejects.toMatchObject({ code: "VAULT_RELEASE_DENIED" });
    expect(await releasesFor(first.step.id)).toHaveLength(0);
    expect(await stepStatus(first.step.id)).toBe("FAILED");
  });

  it("writes nothing when any token in a batch fails", async () => {
    const { name, step, ctx } = await seedRelease();
    const unknown = "00000000-0000-0000-0000-000000000000";
    await expect(
      resolveTokens(
        db,
        `${secretToken("FULL_NAME", name.id)} ${secretToken("NRIC", unknown)}`,
        ctx,
      ),
    ).rejects.toMatchObject({ code: "VAULT_RELEASE_DENIED" });
    expect(await releasesFor(step.id)).toHaveLength(0);
    expect(await stepStatus(step.id)).toBe("FAILED");
  });

  it("returns text without tokens untouched and writes nothing", async () => {
    const { step, ctx } = await seedRelease();
    await expect(resolveTokens(db, "no tokens here", ctx)).resolves.toBe("no tokens here");
    expect(await releasesFor(step.id)).toHaveLength(0);
  });

  it("writes one row for a twice-used token", async () => {
    const { name, step, ctx } = await seedRelease({ approved: false });
    const token = secretToken("FULL_NAME", name.id);
    const out = await resolveTokens(db, `${token} and ${token}`, ctx);
    expect(out).toBe("Tan Ah Kow and Tan Ah Kow");
    expect(await releasesFor(step.id)).toHaveLength(1);
  });
});

describe("sandbox allowlist", () => {
  it.each([
    ["cancel@provider.test", true],
    ["https://forms.provider.test/cancel", true],
    ["http://localhost:3000/hook", true],
    ["http://127.0.0.1:3000/hook", true],
    ["cancel@singtel.com", false],
    ["+6591234567", false],
    ["https://provider.com/cancel", false],
  ])("%s -> %s", (address, expected) => {
    expect(isSandboxAddress(address)).toBe(expected);
  });
});
