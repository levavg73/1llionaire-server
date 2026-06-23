-- Add a lightweight view counter for customer request cards.
ALTER TABLE "event_requests" ADD COLUMN IF NOT EXISTS "view_count" integer NOT NULL DEFAULT 0;
