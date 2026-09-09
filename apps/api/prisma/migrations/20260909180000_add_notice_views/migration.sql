-- CreateTable: dedupe key behind ScrapedItem.views — one row per viewer, per
-- notice, per UTC day.
--
-- The old counter was throttled by notice id alone, so concurrent viewers of
-- the same notice collapsed into a single view. This makes the unit of
-- counting "a distinct viewer", which is what the number is supposed to mean.
--
-- viewer_hash is a salted SHA-256 of IP + user-agent; the raw address is never
-- stored and the hash never needs to be reversed.
CREATE TABLE "notice_views" (
    "notice_id" UUID NOT NULL,
    "viewer_hash" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notice_views_pkey" PRIMARY KEY ("notice_id","viewer_hash","day")
);

-- Pruning old days scans on this.
CREATE INDEX "notice_views_day_idx" ON "notice_views"("day");

-- Cascade so deleting a notice takes its view rows with it, rather than
-- leaving orphans that accumulate forever.
ALTER TABLE "notice_views"
    ADD CONSTRAINT "notice_views_notice_id_fkey"
    FOREIGN KEY ("notice_id") REFERENCES "scraped_items"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
