-- Sync Prisma schema for contracts, escrow status, freelancer reviews, and saved freelancers.
-- This migration is written defensively so it can be applied after the MVP seed/sync migrations.

ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'completion_requested';

DO $$
BEGIN
  CREATE TYPE "EscrowStatus" AS ENUM ('none', 'held', 'released', 'refunded');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "ContractStatus" AS ENUM ('draft', 'pending_customer', 'pending_freelancer', 'fully_signed', 'voided');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "escrow_status" "EscrowStatus" NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "escrow_held_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "escrow_released_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "completion_requested_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "contracts" (
  "id" TEXT NOT NULL,
  "booking_id" TEXT NOT NULL,
  "content_json" JSONB NOT NULL,
  "status" "ContractStatus" NOT NULL DEFAULT 'draft',
  "customer_signed_at" TIMESTAMP(3),
  "customer_signature_hash" TEXT,
  "freelancer_signed_at" TIMESTAMP(3),
  "freelancer_signature_hash" TEXT,
  "fully_signed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "contracts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contracts_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "contracts_booking_id_key" ON "contracts"("booking_id");
CREATE INDEX IF NOT EXISTS "contracts_booking_id_idx" ON "contracts"("booking_id");

CREATE TABLE IF NOT EXISTS "freelancer_reviews" (
  "id" TEXT NOT NULL,
  "booking_id" TEXT NOT NULL,
  "freelancer_id" TEXT NOT NULL,
  "customer_id" TEXT NOT NULL,
  "professionalism_score" INTEGER NOT NULL,
  "communication_score" INTEGER NOT NULL,
  "payment_promptness_score" INTEGER NOT NULL,
  "respect_score" INTEGER NOT NULL,
  "total_score" DOUBLE PRECISION NOT NULL,
  "would_work_again" BOOLEAN NOT NULL,
  "comment" TEXT,
  "status" "ReviewStatus" NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "freelancer_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "freelancer_reviews_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "freelancer_reviews_freelancer_id_fkey" FOREIGN KEY ("freelancer_id") REFERENCES "freelancer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "freelancer_reviews_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "freelancer_reviews_booking_id_key" ON "freelancer_reviews"("booking_id");
CREATE INDEX IF NOT EXISTS "freelancer_reviews_freelancer_id_idx" ON "freelancer_reviews"("freelancer_id");
CREATE INDEX IF NOT EXISTS "freelancer_reviews_customer_id_idx" ON "freelancer_reviews"("customer_id");

CREATE TABLE IF NOT EXISTS "saved_freelancers" (
  "id" TEXT NOT NULL,
  "customer_id" TEXT NOT NULL,
  "freelancer_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "saved_freelancers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "saved_freelancers_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "saved_freelancers_freelancer_id_fkey" FOREIGN KEY ("freelancer_id") REFERENCES "freelancer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "saved_freelancers_customer_id_freelancer_id_key" ON "saved_freelancers"("customer_id", "freelancer_id");
CREATE INDEX IF NOT EXISTS "saved_freelancers_customer_id_idx" ON "saved_freelancers"("customer_id");
CREATE INDEX IF NOT EXISTS "bookings_escrow_status_idx" ON "bookings"("escrow_status");
