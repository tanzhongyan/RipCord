import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "~/shared/config/env";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as {
  conn: postgres.Sql | undefined;
};

const conn =
  globalForDb.conn ?? postgres(env.DATABASE_URL, { connect_timeout: 10, idle_timeout: 30 });
if (env.NODE_ENV !== "production") globalForDb.conn = conn;

export const db = drizzle(conn, { schema });

export type Database = typeof db;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
