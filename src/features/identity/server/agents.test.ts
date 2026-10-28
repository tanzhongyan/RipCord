import { makeSignature } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import { serverSecret } from "~/server/auth/auth";
import { callerFor, seedOauthGrant, seedUser } from "./test-support";

function canonicalQuery(params: URLSearchParams): string {
  const sorted = new URLSearchParams();
  const entries = [...params.entries()].sort(([keyA, valueA], [keyB, valueB]) =>
    keyA < keyB ? -1 : keyA > keyB ? 1 : valueA < valueB ? -1 : valueA > valueB ? 1 : 0,
  );
  for (const [key, value] of entries) sorted.append(key, value);
  return sorted.toString();
}

/** A signed consent-page query, as the authorize endpoint builds it. */
async function signedQuery(params: Record<string, string>): Promise<string> {
  const search = new URLSearchParams({
    ...params,
    exp: String(Math.floor(Date.now() / 1000) + 600),
    ba_iat: String(Date.now()),
  });
  search.set("sig", await makeSignature(canonicalQuery(search), serverSecret()));
  return search.toString();
}

describe("agents router", () => {
  it("lists only the caller's connected agents", async () => {
    const user = await seedUser();
    const other = await seedUser();
    const { clientId } = await seedOauthGrant(user.id, "List Agent");
    const mine = await callerFor(user.id, []).agents.list();
    expect(mine).toContainEqual(expect.objectContaining({ clientId, name: "List Agent" }));
    const theirs = await callerFor(other.id, []).agents.list();
    expect(theirs).not.toContainEqual(expect.objectContaining({ clientId }));
  });

  it("revokes a grant and deletes its tokens", async () => {
    const user = await seedUser();
    const { clientId } = await seedOauthGrant(user.id, "Revoke Agent");
    const caller = callerFor(user.id, []);
    await expect(caller.agents.revoke({ clientId })).resolves.toEqual({ revoked: true });
    const remaining = await caller.agents.list();
    expect(remaining).not.toContainEqual(expect.objectContaining({ clientId }));
    await expect(caller.agents.revoke({ clientId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses to revoke another user's grant", async () => {
    const user = await seedUser();
    const other = await seedUser();
    const { clientId } = await seedOauthGrant(user.id, "Foreign Agent");
    await expect(callerFor(other.id, []).agents.revoke({ clientId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("reads the consent client behind a signed query", async () => {
    const user = await seedUser();
    const { clientId } = await seedOauthGrant(user.id, "Consent Agent");
    const caller = callerFor(user.id, []);
    const oauthQuery = await signedQuery({ client_id: clientId, scope: "ripcord" });
    await expect(caller.agents.consentClient({ clientId, oauthQuery })).resolves.toEqual({
      clientId,
      name: "Consent Agent",
    });
  });

  it("rejects tampered and expired consent queries", async () => {
    const user = await seedUser();
    const { clientId } = await seedOauthGrant(user.id, "Tamper Agent");
    const caller = callerFor(user.id, []);
    const valid = await signedQuery({ client_id: clientId, scope: "ripcord" });
    const tampered = `${valid}&scope=admin`;
    await expect(
      caller.agents.consentClient({ clientId, oauthQuery: tampered }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const expiredParams = new URLSearchParams({ client_id: clientId, exp: "1", ba_iat: "1" });
    expiredParams.set("sig", await makeSignature(canonicalQuery(expiredParams), serverSecret()));
    await expect(
      caller.agents.consentClient({ clientId, oauthQuery: expiredParams.toString() }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
