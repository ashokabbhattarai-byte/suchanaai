-- AI Enrichment State columns for ScrapedItem
ALTER TABLE "scraped_items"
    ADD COLUMN IF NOT EXISTS "summary_status" TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS "summary_attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "summary_provider" TEXT,
    ADD COLUMN IF NOT EXISTS "summary_model" TEXT,
    ADD COLUMN IF NOT EXISTS "summary_error" TEXT,
    ADD COLUMN IF NOT EXISTS "summary_updated_at" TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS "next_summary_retry_at" TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS "embedding_status" TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS "embedding_attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "embedding_error" TEXT,
    ADD COLUMN IF NOT EXISTS "embedding_updated_at" TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS "next_embedding_retry_at" TIMESTAMPTZ;

-- Backfill existing rows: if ai_summary is already present, mark summary_status as completed
UPDATE "scraped_items"
SET "summary_status" = 'completed',
    "summary_updated_at" = COALESCE("ai_analyzed_at", "updated_at", NOW())
WHERE "ai_summary" IS NOT NULL AND "ai_summary" != '';

-- If a notice has an ai_summary or content, set embedding_status to completed
UPDATE "scraped_items"
SET "embedding_status" = 'completed',
    "embedding_updated_at" = COALESCE("ai_analyzed_at", "updated_at", NOW())
WHERE "ai_summary" IS NOT NULL AND "ai_summary" != '';

-- Fast queue lookup index for asynchronous/retry enrichment
CREATE INDEX IF NOT EXISTS "scraped_items_summary_queue_idx"
    ON "scraped_items" ("summary_status", "next_summary_retry_at", "scraped_at");

CREATE INDEX IF NOT EXISTS "scraped_items_embedding_queue_idx"
    ON "scraped_items" ("embedding_status", "next_embedding_retry_at", "scraped_at");
