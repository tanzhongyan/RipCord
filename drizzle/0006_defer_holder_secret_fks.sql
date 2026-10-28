-- Custom SQL migration file, put your code below! --
-- account_holders.phone_secret_id and vault_secrets.holder_id reference each
-- other, so neither row can be inserted first under immediate checks. Both
-- constraints become DEFERRABLE INITIALLY DEFERRED; holders.create inserts both
-- rows in one transaction and the checks run at commit. Drizzle cannot express
-- deferrable constraints, so this lives here.
ALTER TABLE account_holders
  ALTER CONSTRAINT account_holders_phone_secret_id_vault_secrets_id_fk
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE vault_secrets
  ALTER CONSTRAINT vault_secrets_holder_id_account_holders_id_fk
  DEFERRABLE INITIALLY DEFERRED;
