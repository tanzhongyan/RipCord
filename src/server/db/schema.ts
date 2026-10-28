import { index, pgTable } from "drizzle-orm/pg-core";

export const notes = pgTable(
  "notes",
  (d) => ({
    id: d.integer().primaryKey().generatedByDefaultAsIdentity(),
    ownerId: d.varchar("owner_id", { length: 256 }).notNull(),
    title: d.varchar("title", { length: 200 }).notNull(),
    body: d.text("body").notNull(),
    createdAt: d.timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: d.timestamp("updated_at", { withTimezone: true }).$onUpdate(() => new Date()),
  }),
  (t) => [index("notes_owner_idx").on(t.ownerId)],
);
