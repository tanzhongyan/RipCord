import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { POST as requestOtpCode } from "~/app/api/mandates/[mandateId]/otp/route";
import { POST as signMandateRoute } from "~/app/api/mandates/[mandateId]/sign/route";
import { setValkeyOverride as setIdentityValkey, setSmsOverride } from "~/features/identity";
import { seedProviders } from "~/features/providers";
import { createCaller } from "~/server/api/root";
import { db } from "~/server/db";
import { accountHolders, caseSteps, cases, providers } from "~/server/db/schema";
import { setFakeResponses } from "~/server/model/fake";
import { documentKey } from "~/server/storage";
import { setEventsOverride } from "./events";
import { runNextStep } from "./executor";
import { setMailOverride } from "./mailer";
import { planChannel } from "./planner";
import {
  createSmsOutbox,
  FakeEvents,
  FakeMailTransport,
  FakeStorage,
  FakeValkey,
  seedBillingCustomer,
  seedCredit,
  seedHolder,
  seedUser,
  testToolContext,
} from "./test-support";
import { callTool } from "./tools/registry";

const ACTOR = { type: "USER" as const, id: "demo-owner" };

afterEach(() => {
  setEventsOverride(null);
  setFakeResponses([]);
  setMailOverride(null);
  setIdentityValkey(null);
  setSmsOverride(null);
});

function billExtractionResponse() {
  return {
    text: JSON.stringify({
      provider_name: "Demo Telco",
      service_type: "MOBILE_POSTPAID",
      account_no: "DT-88231-004",
      holder_full_name: "Demo Dad",
      monthly_fee_cents: 4500,
      contract_start: "2026-06-01",
      contract_end_date: "2028-05-31",
      min_term_months: 24,
      etf_clause_text: null,
      notice_days: 30,
      equipment: ["router"],
      bundle_links: [],
      evidence: [{ page: 1, quote: "Contract ends: 31 May 2028" }],
    }),
  };
}

function cardsResponse(say: string) {
  return {
    text: JSON.stringify({ cards: [{ kind: "COUNTER", say, why: "The mandate says so." }] }),
  };
}

function callConfirmedResponse() {
  return {
    text: JSON.stringify({
      reference_code: "DT-48213",
      effective_date: "2026-11-30",
      final_bill_estimate_cents: 1240,
      outcome: "CONFIRMED",
      requested_items: [],
    }),
  };
}

async function postRoute(
  route: (req: Request, ctx: { params: Promise<{ mandateId: string }> }) => Promise<Response>,
  mandateId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await route(
    new Request("http://localhost/api/mandates/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ mandateId }) },
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("B10 Demo path", () => {
  it("drives the demo-telco case from intake to DISPUTED on the rebilled fixture", async () => {
    const counts = await seedProviders(db);
    expect(counts.demoChannels).toBe(2);
    const events = new FakeEvents();
    setEventsOverride(events);
    const mail = new FakeMailTransport();
    setMailOverride(mail);
    const valkey = new FakeValkey();
    setIdentityValkey(valkey);
    const outbox = createSmsOutbox();
    setSmsOverride(outbox.sender);

    // 1. Sign in, create holder "Dad", buy 1 credit, create the case.
    const user = await seedUser();
    const holder = await seedHolder(user.id, { alias: "Dad" });
    await db
      .update(accountHolders)
      .set({ userId: user.id })
      .where(eq(accountHolders.id, holder.id));
    const customer = await seedBillingCustomer({ userId: user.id });
    await seedCredit(customer.id, { delta: 1 });
    const storage = new FakeStorage();
    const ctx = testToolContext(user.id, [], { storage });
    const [demo] = await db
      .select({ id: providers.id })
      .from(providers)
      .where(eq(providers.slug, "demo-telco"))
      .limit(1);
    if (!demo) throw new Error("demo-telco missing after seeds");
    const providerId = demo.id;
    const created = (await callTool("create-case", { holderId: holder.id, providerId }, ctx)) as {
      caseId: string;
    };
    const caseId = created.caseId;
    const started = (await callTool("start-case", { caseId, confirm: true }, ctx)) as {
      status: string;
    };
    expect(started.status).toBe("DISCOVERY");

    // 2. Upload the demo bill; extraction fills the terms and recommendation.
    const attached = (await callTool(
      "attach-document",
      { caseId, kind: "BILL", contentType: "application/pdf", contentLength: 1000 },
      ctx,
    )) as { documentId: string };
    const billBytes = new Uint8Array(readFileSync("public/demo/demo-telco-bill.pdf"));
    await storage.put(
      documentKey(caseId, attached.documentId, "pdf"),
      billBytes,
      "application/pdf",
    );
    setFakeResponses([billExtractionResponse()]);
    const extracted = (await callTool(
      "extract-document",
      { caseId, documentId: attached.documentId },
      ctx,
    )) as { status: string };
    expect(extracted.status).toBe("PRE_FLIGHT_AUDIT");
    const accepted = (await callTool("accept-recommendation", { caseId }, ctx)) as {
      status: string;
    };
    expect(accepted.status).toBe("AWAITING_MANDATE");

    // 3. Request the mandate, open the link, enter the code, sign.
    const requested = (await callTool(
      "request-mandate",
      { caseId, actions: ["CANCEL_SERVICE"], maxFeeCents: 500, confirm: true },
      ctx,
    )) as { mandateId: string };
    const link = outbox.messages[0]?.body ?? "";
    const token = /[?&]t=([A-Za-z0-9_-]+)/.exec(link)?.[1];
    expect(token).toBeDefined();
    const otp = await postRoute(requestOtpCode, requested.mandateId, { token });
    expect(otp.json).toMatchObject({ ok: true });
    const code = /(\d{6})/.exec(outbox.messages[1]?.body ?? "")?.[1];
    expect(code).toBeDefined();
    const signed = await postRoute(signMandateRoute, requested.mandateId, {
      token,
      code,
      typedName: "Demo Dad",
      allowLive: false,
      fullName: "Demo Dad",
      nric: "S1234567D",
    });
    expect(signed.json).toMatchObject({ ok: true });
    const [awaiting] = await db
      .select({ status: cases.status, sandbox: cases.sandbox })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1);
    expect(awaiting?.status).toBe("CHANNEL_PLANNING");
    expect(awaiting?.sandbox).toBe(true);

    // 4. EMAIL: approve, the notice lands in the outbox; the reply re-plans.
    const planned = await planChannel(caseId, ACTOR);
    expect(planned).toMatchObject({ planned: true, kind: "EMAIL" });
    const parkedEmail = await runNextStep(caseId);
    expect(parkedEmail.status).toBe("waiting_approval");
    const emailSteps = await db.select().from(caseSteps).where(eq(caseSteps.caseId, caseId));
    const sendStep = emailSteps.find((row) => row.tool === "send-notice-email");
    if (!sendStep) throw new Error("send-notice-email step missing");
    await callTool("approve-step", { caseId, stepId: sendStep.id, confirm: true }, ctx);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.text).toContain("2028-05-01");
    const caller = createCaller({
      db,
      userId: user.id,
      orgIds: [],
      ownerId: user.id,
      headers: new Headers(),
    });
    setFakeResponses([
      {
        text: JSON.stringify({
          reference_code: null,
          effective_date: null,
          final_bill_estimate_cents: null,
          outcome: "NEEDS_MORE_INFO",
          requested_items: ["Call +15005550006 to complete termination"],
        }),
      },
    ]);
    const pasted = await caller.cases.pasteReply({
      caseId,
      text: readFileSync("public/demo/demo-telco-reply-needs-call.txt", "utf8"),
    });
    expect(pasted.action).toBe("replanned");

    // 5. PHONE_IVR: approve, the simulated call plays, cards and bridge fire.
    const parkedCall = await runNextStep(caseId);
    expect(parkedCall.status).toBe("waiting_approval");
    const callSteps = await db.select().from(caseSteps).where(eq(caseSteps.caseId, caseId));
    const placeCall = callSteps.find((row) => row.tool === "place-call");
    if (!placeCall) throw new Error("place-call step missing");
    setFakeResponses([
      cardsResponse("No thanks, please cancel the service as requested."),
      cardsResponse("Thanks, please confirm the reference in writing."),
      callConfirmedResponse(),
    ]);
    await callTool("approve-step", { caseId, stepId: placeCall.id, confirm: true }, ctx);
    const [receipting] = await db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1);
    expect(receipting?.status).toBe("RECEIPT_ACQUISITION");
    const cardEvents = events.published.filter((event) =>
      (event.message as string).includes('"type":"card"'),
    );
    expect(cardEvents.length).toBeGreaterThanOrEqual(1);
    expect(
      events.published.some((event) => (event.message as string).includes("holder_joined")),
    ).toBe(true);

    // 6. Confirm the receipt, then the rebilled check disputes the case.
    const recorded = (await callTool(
      "record-receipt",
      {
        caseId,
        referenceCode: "DT-48213",
        effectiveDate: "2026-11-30",
        finalBillEstimateCents: 1240,
        confirm: true,
      },
      ctx,
    )) as { status: string };
    expect(recorded.status).toBe("AWAITING_VERIFICATION");
    const checked = (await callTool(
      "report-bill-check",
      { caseId, result: "REBILLED", confirm: true },
      ctx,
    )) as { status: string };
    expect(checked.status).toBe("DISPUTED");
    const [closed] = await db
      .select({ status: cases.status, closedAt: cases.closedAt })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1);
    expect(closed?.status).toBe("DISPUTED");
    expect(closed?.closedAt).not.toBeNull();
  }, 120000);
});
