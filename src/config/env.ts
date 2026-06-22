import { z } from "zod";

const envSchema = z.object({
  // ─── 데이터베이스 ──────────────────────────────────────────
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DIRECT_URL: z.string().optional(),

  // ─── JWT ──────────────────────────────────────────────────
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("30d"),
  AUTH_COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).optional(),

  // ─── 서버 ─────────────────────────────────────────────────
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // ─── CORS / Origin ────────────────────────────────────────
  CLIENT_URL: z.string().url("CLIENT_URL must be a valid URL"),
  CLIENT_URL_PROD: z.string().url().optional().or(z.literal("")),

  // ─── 토스페이먼츠 ─────────────────────────────────────────
  TOSS_SECRET_KEY: z
    .string()
    .optional()
    .refine(
      (v) =>
        !v || v.startsWith("test_sk_") || v.startsWith("live_sk_"),
      "TOSS_SECRET_KEY는 test_sk_ 또는 live_sk_로 시작해야 합니다."
    ),
  TOSS_CLIENT_KEY: z
    .string()
    .optional()
    .refine(
      (v) =>
        !v || v.startsWith("test_ck_") || v.startsWith("live_ck_"),
      "TOSS_CLIENT_KEY는 test_ck_ 또는 live_ck_로 시작해야 합니다."
    ),

  // ─── Supabase Storage ─────────────────────────────────────
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),
  SUPABASE_PROFILE_IMAGE_BUCKET: z.string().default("profile-images"),

  // ─── 소셜 로그인 (카카오) ─────────────────────────────────
  KAKAO_CLIENT_ID: z.string().optional(),
  KAKAO_CLIENT_SECRET: z.string().optional(),
  // 카카오 OAuth redirect URI: 서버 콜백 URL
  // ex) https://api.voit.co.kr/api/auth/oauth/kakao/callback
  KAKAO_REDIRECT_URI: z.string().url().optional(),

  // ─── 소셜 로그인 (구글) ───────────────────────────────────
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),

  // ─── AI (Google Gemini) ───────────────────────────────────
  GEMINI_API_KEY: z.string().optional(),
  // Optional alias for platforms or local setups that already use GOOGLE_API_KEY
  GOOGLE_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),

  // ─── 에스크로 자동 릴리즈 (행사 완료 후 N일) ───────────────
  ESCROW_AUTO_RELEASE_DAYS: z.coerce.number().int().min(1).default(7),

  // ─── Seed 전용 ────────────────────────────────────────────
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
});

export const env = envSchema.parse(process.env);

export const isProduction = env.NODE_ENV === "production";

// 결제 키 런타임 검증 헬퍼 (payments.ts에서 호출)
export function requireTossKeys(): { secretKey: string; clientKey: string } {
  if (!env.TOSS_SECRET_KEY || !env.TOSS_CLIENT_KEY) {
    throw new Error(
      "TOSS_SECRET_KEY 또는 TOSS_CLIENT_KEY 환경변수가 설정되지 않았습니다."
    );
  }
  return { secretKey: env.TOSS_SECRET_KEY, clientKey: env.TOSS_CLIENT_KEY };
}

// AI 키 런타임 검증 헬퍼 (ai.ts에서 호출)
export function requireGeminiKey(): string {
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY 환경변수가 설정되지 않았습니다.");
  }
  return apiKey;
}