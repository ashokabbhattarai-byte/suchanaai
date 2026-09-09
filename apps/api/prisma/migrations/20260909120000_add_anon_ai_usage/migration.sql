-- CreateTable: free chatbot allowance for signed-out visitors, per client per
-- UTC day. Persisted rather than held in memory so the allowance survives a
-- deploy and holds across API replicas.
--
-- client_hash is a salted SHA-256 of the caller's IP — the raw address is never
-- stored, and this counter never needs to be reversed to a person.
CREATE TABLE "anon_ai_usage" (
    "client_hash" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "anon_ai_usage_pkey" PRIMARY KEY ("client_hash","day")
);

-- Pruning yesterday's rows scans on this.
CREATE INDEX "anon_ai_usage_day_idx" ON "anon_ai_usage"("day");
