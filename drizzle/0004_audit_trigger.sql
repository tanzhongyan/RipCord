-- Custom SQL migration file, put your code below! --
-- audit_logs is append-only: the data contract requires the database to reject
-- UPDATE and DELETE. Drizzle cannot express triggers, so it lives here, after
-- the generated migration that creates the table.
CREATE OR REPLACE FUNCTION reject_audit_logs_write() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_logs_no_update_delete ON audit_logs;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_audit_logs_write();
