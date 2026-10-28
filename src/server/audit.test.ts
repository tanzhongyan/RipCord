import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { canonicalJson, verifyAuditChain, writeAudit } from "~/server/audit";
import { db } from "~/server/db";

describe("audit chain", () => {
  it("verifies a clean chain", async () => {
    await writeAudit(db, {
      actorType: "SYSTEM",
      actorId: "test",
      action: "CHAIN_CLEAN_A",
      targetType: "test",
      targetId: "a",
      caseId: null,
      metadata: { n: 1 },
    });
    await writeAudit(db, {
      actorType: "SYSTEM",
      actorId: "test",
      action: "CHAIN_CLEAN_B",
      targetType: "test",
      targetId: "b",
      caseId: null,
      metadata: { n: 2 },
    });
    const result = await verifyAuditChain(db);
    expect(result.ok).toBe(true);
  });

  it("canonicalises JSON with sorted keys", () => {
    expect(canonicalJson({ b: 1, a: [3, { d: 4, c: 5 }] })).toBe('{"a":[3,{"c":5,"d":4}],"b":1}');
    expect(canonicalJson(null)).toBe("null");
  });

  it("serializes concurrent writers without breaking the chain", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        writeAudit(db, {
          actorType: "SYSTEM",
          actorId: "test",
          action: "CHAIN_RACE",
          targetType: "test",
          targetId: String(n),
          caseId: null,
          metadata: { n },
        }),
      ),
    );
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true });
  });
});

describe("B7 Audit immutability", () => {
  it("rejects UPDATE and DELETE on audit_logs", async () => {
    await writeAudit(db, {
      actorType: "SYSTEM",
      actorId: "test",
      action: "CHAIN_IMMUTABLE",
      targetType: "test",
      targetId: "x",
      caseId: null,
      metadata: {},
    });
    // Drizzle wraps the Postgres error; the trigger message rides on `cause`.
    const failedUpdate = await db
      .execute(sql`update audit_logs set metadata = '{}' where action = 'CHAIN_IMMUTABLE'`)
      .then(
        () => null,
        (error: unknown) => error as { cause?: unknown },
      );
    expect(String(failedUpdate?.cause)).toContain("audit_logs is append-only");
    const failedDelete = await db
      .execute(sql`delete from audit_logs where action = 'CHAIN_IMMUTABLE'`)
      .then(
        () => null,
        (error: unknown) => error as { cause?: unknown },
      );
    expect(String(failedDelete?.cause)).toContain("audit_logs is append-only");
  });
});

describe("B8 Chain check", () => {
  it("reports the break at the tampered row", async () => {
    const marker = `CHAIN_BREAK_${Date.now()}`;
    for (let n = 0; n < 100; n++) {
      await writeAudit(db, {
        actorType: "SYSTEM",
        actorId: "test",
        action: marker,
        targetType: "test",
        targetId: String(n),
        caseId: null,
        metadata: { n },
      });
    }
    const rows = await db.execute<{ id: string; metadata: unknown }>(
      sql`select id, metadata from audit_logs where action = ${marker} order by id`,
    );
    const row49 = rows[49] as { id: string; metadata: unknown };
    const fiftiethId = Number(row49.id);
    const originalMetadata = JSON.stringify(row49.metadata);

    await db.execute(sql`alter table audit_logs disable trigger audit_logs_no_update_delete`);
    try {
      await db.execute(
        sql`update audit_logs set metadata = '{"n":"tampered"}' where id = ${fiftiethId}`,
      );
      // The window must cover this file's rows plus any older test rows.
      const broken = await verifyAuditChain(db);
      expect(broken).toEqual({ ok: false, breakAtId: fiftiethId });
    } finally {
      await db.execute(
        sql`update audit_logs set metadata = ${originalMetadata}::jsonb where id = ${fiftiethId}`,
      );
      await db.execute(sql`alter table audit_logs enable trigger audit_logs_no_update_delete`);
    }
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true });
  });
});
