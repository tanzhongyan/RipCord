-- Custom SQL migration file, put your code below! --
-- pg_trgm backs the fuzzy provider-name lookup (providers_name_trgm_idx).
-- Drizzle cannot express CREATE EXTENSION, so it lives here, ahead of the
-- generated migration that creates the index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
