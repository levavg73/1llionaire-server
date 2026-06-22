import { env } from "../config/env";

const CLIENT_PREVIEW_ORIGIN_PATTERN =
  /^https:\/\/voit-client-[a-z0-9-]+-seori-s-projects\.vercel\.app$/i;

const normalizeOrigin = (value: string): string => new URL(value).origin;

export const getAllowedClientOrigins = (): string[] => {
  const origins = [env.CLIENT_URL, env.CLIENT_URL_PROD]
    .filter(Boolean)
    .map((value) => normalizeOrigin(value as string));

  return Array.from(new Set(origins));
};

export const isAllowedClientOrigin = (origin: string | undefined): boolean => {
  if (!origin) return true;

  let normalized: string;
  try {
    normalized = normalizeOrigin(origin);
  } catch {
    return false;
  }

  if (getAllowedClientOrigins().includes(normalized)) return true;

  // Vercel preview deployments used for Lighthouse/QA have per-deploy domains.
  // Keep this narrow to this project/team instead of allowing every *.vercel.app origin.
  return CLIENT_PREVIEW_ORIGIN_PATTERN.test(normalized);
};
