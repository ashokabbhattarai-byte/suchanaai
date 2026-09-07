-- AlterTable: store the actionable explanation of a failed/empty scrape run,
-- so the admin UI can show what to change instead of only what broke.
ALTER TABLE "scrape_sources"
    ADD COLUMN "last_diagnosis" JSONB,
    ADD COLUMN "last_diagnosed_at" TIMESTAMP(3);

-- Same, kept per-run so the Logs view can explain historical failures too.
ALTER TABLE "scrape_runs"
    ADD COLUMN "diagnosis" JSONB;
