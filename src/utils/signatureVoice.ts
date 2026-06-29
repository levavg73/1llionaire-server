import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config/env";

export const SIGNATURE_VOICE_MAX_SIZE = 10 * 1024 * 1024;
export const SIGNATURE_VOICE_BUCKET = env.SUPABASE_SIGNATURE_VOICE_BUCKET;
export const SIGNATURE_VOICE_SIGNED_URL_EXPIRES_IN = 60 * 60;
const SIGNATURE_VOICE_SIGNED_URL_CACHE_TTL_MS = Math.max(
  (SIGNATURE_VOICE_SIGNED_URL_EXPIRES_IN - 60) * 1000,
  0
);

type SignedUrlCacheEntry = {
  url: string | null;
  expiresAt: number;
};

const signedUrlCache = new Map<string, SignedUrlCacheEntry>();

let supabaseAdminClient: SupabaseClient | null = null;

const SIGNATURE_VOICE_SAFE_PATH_PATTERN = /^freelancers\/[^/\\]+\/signature-voice\/[^/\\]+$/;

export function isSafeSignatureVoicePath(path?: string | null) {
  return Boolean(
    path &&
      SIGNATURE_VOICE_SAFE_PATH_PATTERN.test(path) &&
      !path.includes("..")
  );
}

export function isOwnSignatureVoicePath(userId: string, path?: string | null) {
  const prefix = `freelancers/${userId}/signature-voice/`;
  return Boolean(
    path &&
      path.startsWith(prefix) &&
      isSafeSignatureVoicePath(path)
  );
}

export function getSupabaseSignatureVoiceAdminClient() {
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;

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

export async function createSignatureVoiceSignedUrl(path?: string | null) {
  if (!path || !isSafeSignatureVoicePath(path)) return null;

  const cached = signedUrlCache.get(path);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  try {
    const { data, error } = await getSupabaseSignatureVoiceAdminClient()
      .storage
      .from(SIGNATURE_VOICE_BUCKET)
      .createSignedUrl(path, SIGNATURE_VOICE_SIGNED_URL_EXPIRES_IN);

    if (error) {
      console.error("[supabase-signature-voice-signed-url-error]", error);
      signedUrlCache.set(path, {
        url: null,
        expiresAt: Date.now() + 60 * 1000,
      });
      return null;
    }

    signedUrlCache.set(path, {
      url: data.signedUrl,
      expiresAt: Date.now() + SIGNATURE_VOICE_SIGNED_URL_CACHE_TTL_MS,
    });

    return data.signedUrl;
  } catch (err) {
    console.error("[supabase-signature-voice-signed-url-config-error]", err);
    signedUrlCache.set(path, {
      url: null,
      expiresAt: Date.now() + 60 * 1000,
    });
    return null;
  }
}

export async function attachSignedSignatureVoiceUrl<
  T extends { signature_voice_path?: string | null; signature_voice_url?: string | null },
>(profile: T): Promise<T> {
  const signedUrl = await createSignatureVoiceSignedUrl(profile.signature_voice_path);

  return {
    ...profile,
    signature_voice_url: signedUrl,
  };
}

export async function attachSignedSignatureVoiceUrls<
  T extends { signature_voice_path?: string | null; signature_voice_url?: string | null },
>(profiles: T[]): Promise<T[]> {
  return Promise.all(profiles.map((profile) => attachSignedSignatureVoiceUrl(profile)));
}