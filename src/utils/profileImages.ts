import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const PROFILE_IMAGE_MAX_SIZE = 5 * 1024 * 1024;
export const PROFILE_IMAGE_BUCKET = process.env.SUPABASE_PROFILE_IMAGE_BUCKET ?? "profile-images";
export const PROFILE_IMAGE_SIGNED_URL_EXPIRES_IN = 60 * 60;
const PROFILE_IMAGE_SIGNED_URL_CACHE_TTL_MS = Math.max(
  (PROFILE_IMAGE_SIGNED_URL_EXPIRES_IN - 60) * 1000,
  0
);

type SignedUrlCacheEntry = {
  url: string | null;
  expiresAt: number;
};

const signedUrlCache = new Map<string, SignedUrlCacheEntry>();

let supabaseAdminClient: SupabaseClient | null = null;

const PROFILE_IMAGE_SAFE_PATH_PATTERN = /^freelancers\/[^/\\]+\/[^/\\]+$/;

export function isSafeProfileImagePath(path?: string | null) {
  return Boolean(
    path &&
      PROFILE_IMAGE_SAFE_PATH_PATTERN.test(path) &&
      !path.includes("..")
  );
}

export function isOwnProfileImagePath(userId: string, path?: string | null) {
  const prefix = `freelancers/${userId}/`;
  return Boolean(
    path &&
      path.startsWith(prefix) &&
      isSafeProfileImagePath(path)
  );
}

export function getSupabaseAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase Storage 환경변수가 설정되지 않았습니다.");
  }

  if (!supabaseAdminClient) {
    supabaseAdminClient = createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  return supabaseAdminClient;
}

export async function createProfileImageSignedUrl(path?: string | null) {
  if (!path || !isSafeProfileImagePath(path)) return null;

  const cached = signedUrlCache.get(path);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  try {
    const { data, error } = await getSupabaseAdminClient()
      .storage
      .from(PROFILE_IMAGE_BUCKET)
      .createSignedUrl(path, PROFILE_IMAGE_SIGNED_URL_EXPIRES_IN);

    if (error) {
      console.error("[supabase-profile-image-signed-url-error]", error);
      signedUrlCache.set(path, {
        url: null,
        expiresAt: Date.now() + 60 * 1000,
      });
      return null;
    }

    signedUrlCache.set(path, {
      url: data.signedUrl,
      expiresAt: Date.now() + PROFILE_IMAGE_SIGNED_URL_CACHE_TTL_MS,
    });

    return data.signedUrl;
  } catch (err) {
    console.error("[supabase-profile-image-signed-url-config-error]", err);
    signedUrlCache.set(path, {
      url: null,
      expiresAt: Date.now() + 60 * 1000,
    });
    return null;
  }
}

export async function attachSignedProfileImageUrl<
  T extends { profile_image_path?: string | null; profile_image_url?: string | null },
>(profile: T): Promise<T> {
  const signedUrl = await createProfileImageSignedUrl(profile.profile_image_path);

  return {
    ...profile,
    profile_image_url: signedUrl,
  };
}

export async function attachSignedProfileImageUrls<
  T extends { profile_image_path?: string | null; profile_image_url?: string | null },
>(profiles: T[]): Promise<T[]> {
  return Promise.all(profiles.map((profile) => attachSignedProfileImageUrl(profile)));
}
