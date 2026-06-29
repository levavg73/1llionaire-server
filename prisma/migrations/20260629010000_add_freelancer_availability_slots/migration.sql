-- Add optional freelancer availability slots for schedule-aware AI matching.
-- MVP policy: freelancers with no slots are treated as available by default.
CREATE TABLE "freelancer_availability_slots" (
  "id" TEXT NOT NULL,
  "freelancer_id" TEXT NOT NULL,
  "available_date" TIMESTAMP(3) NOT NULL,
  "start_time" TEXT NOT NULL,
  "end_time" TEXT NOT NULL,
  "note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "freelancer_availability_slots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "freelancer_availability_slots_freelancer_id_available_date_idx"
  ON "freelancer_availability_slots"("freelancer_id", "available_date");

ALTER TABLE "freelancer_availability_slots"
  ADD CONSTRAINT "freelancer_availability_slots_freelancer_id_fkey"
  FOREIGN KEY ("freelancer_id") REFERENCES "freelancer_profiles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
