-- Add optional 30-second signature voice sample fields for freelancer profiles.
ALTER TABLE "freelancer_profiles"
  ADD COLUMN "signature_voice_url" TEXT,
  ADD COLUMN "signature_voice_path" TEXT;
