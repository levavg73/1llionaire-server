import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DIRECT_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("30d"),
  CLIENT_URL: z.string().url("CLIENT_URL must be a valid URL"),
  CLIENT_URL_PROD: z.string().url().optional().or(z.literal("")),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  VERCEL: z.string().optional(),
});

export const env = envSchema.parse(process.env);

export const isProduction = env.NODE_ENV === "production";
export const isVercel = env.VERCEL === "1";
