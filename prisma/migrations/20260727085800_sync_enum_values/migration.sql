-- New enum values must be committed before they can be used (Postgres 55P04),
-- so they live in their own migration ahead of 20260727085900_sync_schema_after_db_push.
ALTER TYPE "ClientStatus" ADD VALUE 'PROSPECT';
ALTER TYPE "DocumentStatus" ADD VALUE 'SIGNING';
ALTER TYPE "DocumentStatus" ADD VALUE 'SIGNED';
