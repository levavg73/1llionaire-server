import { z } from "zod";

const envSchema = z.object({
  // ─── 데이터베이스 ──────────────────────────────────────────
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DIRECT_URL: z.string().optional(),

  // ─── JWT ──────────────────────────────────────────────────
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("30d"),

  // ─── 서버 ─────────────────────────────────────────────────
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // ─── CORS / Origin ────────────────────────────────────────
  CLIENT_URL: z.string().url("CLIENT_URL must be a valid URL"),
  CLIENT_URL_PROD: z.string().url().optional().or(z.literal("")),

  // ─── 토스페이먼츠 ─────────────────────────────────────────
  TOSS_SECRET_KEY: z
    .string()
    .min(1, "TOSS_SECRET_KEY is required")
    .refine(
      (v: string) => v.startsWith("test_sk_") || v.startsWith("live_sk_"),
      "TOSS_SECRET_KEY는 test_sk_ 또는 live_sk_로 시작해야 합니다."
    ),
  TOSS_CLIENT_KEY: z
    .string()
    .min(1, "TOSS_CLIENT_KEY is required")
    .refine(
      (v: string) => v.startsWith("test_ck_") || v.startsWith("live_ck_"),
      "TOSS_CLIENT_KEY는 test_ck_ 또는 live_ck_로 시작해야 합니다."
    ),

  // ─── Seed 전용 ────────────────────────────────────────────
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
});

export const env = envSchema.parse(process.env);

export const isProduction = env.NODE_ENV === "production";