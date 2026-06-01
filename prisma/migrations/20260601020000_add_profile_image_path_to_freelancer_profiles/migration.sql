-- Ensure private Supabase profile image storage path exists.
ALTER TABLE freelancer_profiles
  ADD COLUMN IF NOT EXISTS profile_image_path TEXT;
