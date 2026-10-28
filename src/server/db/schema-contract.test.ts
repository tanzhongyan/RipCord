import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "~/server/db";

/**
 * The 0000 data contract names every column of the compliance tables. This
 * test reads the live database and fails when the schema drifts from it.
 */
const CONTRACT_COLUMNS: Record<string, string[]> = {
  vault_secrets: [
    "id",
    "holder_id",
    "kind",
    "ciphertext",
    "iv",
    "wrapped_dek",
    "key_version",
    "display_hint",
    "last_used_at",
    "deleted_at",
    "created_at",
  ],
  vault_releases: [
    "id",
    "secret_id",
    "case_id",
    "step_id",
    "provider_channel_id",
    "mandate_id",
    "holder_approved_at",
    "released_at",
    "created_at",
  ],
  audit_logs: [
    "id",
    "actor_type",
    "actor_id",
    "action",
    "target_type",
    "target_id",
    "case_id",
    "metadata",
    "prev_hash",
    "hash",
    "created_at",
  ],
  data_subject_requests: [
    "id",
    "user_id",
    "holder_id",
    "kind",
    "status",
    "completed_at",
    "created_at",
  ],
};

describe("0000 schema contract", () => {
  for (const [table, columns] of Object.entries(CONTRACT_COLUMNS)) {
    it(`matches ${table} exactly`, async () => {
      const rows = await db.execute<{ column_name: string }>(
        sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table} order by ordinal_position`,
      );
      expect(rows.map((row) => row.column_name)).toEqual(columns);
    });
  }

  it("keeps the audit append-only trigger", async () => {
    const rows = await db.execute<{ trigger_name: string }>(
      sql`select trigger_name from information_schema.triggers where event_object_table = 'audit_logs'`,
    );
    expect(rows.map((row) => row.trigger_name)).toContain("audit_logs_no_update_delete");
  });
});
