-- Alert delivery was gated entirely on a verified WhatsApp number: a user
-- who never connected one had their rules skipped by the matcher, so
-- match_count stayed at 0 forever and nothing was ever delivered. Matching
-- now runs for every user and fans out over whichever channels exist.

-- Email alerts go to the account address, so there is nothing to verify —
-- default on, since it is the only channel a user has before WhatsApp.
ALTER TABLE "users"
    ADD COLUMN "email_alerts_enabled" BOOLEAN NOT NULL DEFAULT true;

-- Matched, recorded, but nothing to deliver over (no channel connected, SMTP
-- off, monthly allowance spent). Previously written as FAILED, which made a
-- normal state look like a broken one.
ALTER TYPE "AlertNotificationStatus" ADD VALUE IF NOT EXISTS 'SKIPPED';

-- Which channels actually accepted the message, e.g. {whatsapp,email}.
ALTER TABLE "alert_notifications"
    ADD COLUMN "channels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Null until the user opens the in-app feed — drives the header bell badge.
ALTER TABLE "alert_notifications"
    ADD COLUMN "read_at" TIMESTAMP(3);

-- The digest drains PENDING per user; the feed reads newest-first per user.
CREATE INDEX "alert_notifications_user_id_status_idx"
    ON "alert_notifications"("user_id", "status");
CREATE INDEX "alert_notifications_user_id_sent_at_idx"
    ON "alert_notifications"("user_id", "sent_at");
