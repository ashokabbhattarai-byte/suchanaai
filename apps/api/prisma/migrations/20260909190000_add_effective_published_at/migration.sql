-- One column to order "latest" by, everywhere.
--
-- Two things were wrong. Plain `ORDER BY published_at DESC` sorts NULLs FIRST
-- in Postgres, and 88% of notices have no source date — so every "latest" list
-- was topped by undated rows in arbitrary order. Switching to NULLS LAST only
-- moves the problem: it buries everything scraped recently beneath the 12% that
-- happen to carry a date.
--
-- COALESCE is the honest ordering: the real publication date when the source
-- gave us one, and the moment we first saw the notice when it did not. Kept as
-- a STORED generated column so Postgres maintains it — there is no write path
-- that can forget to update it, and it can be indexed.
-- The CASE guards a second bug: Nepali sites write Bikram Sambat in ASCII
-- ("2083-03-19"), which parsed as Gregorian year 2083 and left 88 notices
-- dated ~57 years in the future — enough to top every "latest" list until
-- 2083. A notice cannot be published more than a year after we scraped it, so
-- any date that far ahead of its own scrape is a mis-parse and falls back to
-- scraped_at. Expressed against scraped_at rather than now() because a
-- generated column must be IMMUTABLE.
ALTER TABLE "scraped_items"
    ADD COLUMN "effective_published_at" TIMESTAMP(3)
    GENERATED ALWAYS AS (
        CASE
            WHEN "published_at" IS NULL THEN "scraped_at"
            WHEN "published_at" > "scraped_at" + INTERVAL '1 year' THEN "scraped_at"
            ELSE "published_at"
        END
    ) STORED;

-- Every notice list orders on this, newest first.
CREATE INDEX "scraped_items_effective_published_at_idx"
    ON "scraped_items" ("effective_published_at" DESC);

-- Category- and source-filtered listings are the common case on the notices
-- page; these keep those from falling back to a full scan plus sort.
CREATE INDEX "scraped_items_category_effective_idx"
    ON "scraped_items" ("category", "effective_published_at" DESC);

CREATE INDEX "scraped_items_source_effective_idx"
    ON "scraped_items" ("source_id", "effective_published_at" DESC);
