import crypto from "crypto";
import { Response } from "express";
import jwt from "jsonwebtoken";
import prisma from "../config/database";
import { env, isProduction } from "../config/env";

const ACCESS_TOKEN_COOKIE = "access_token";
const REFRESH_TOKEN_COOKIE = "refresh_token";

const parseDurationMs = (value: string, fallbackMs: number): number => {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) return fallbackMs;

  const amount = Number(match[1]);
  const unit = match[2];
  const unitMs: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return amount * unitMs[unit];
};

const cookieBaseOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" as const : "lax" as const,
  path: "/",
};

export const getCookie = (cookieHeader: string | undefined, name: string): string | undefined => {
  if (!cookieHeader) return undefined;

  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .reduce<string | undefined>((found, part) => {
      if (found) return found;
      const [key, ...valueParts] = part.split("=");
      if (key !== name) return undefined;
      return decodeURIComponent(valueParts.join("="));
    }, undefined);
};

export const getAccessTokenFromRequest = (cookieHeader: string | undefined): string | undefined => {
  return getCookie(cookieHeader, ACCESS_TOKEN_COOKIE);
};

export const getRefreshTokenFromRequest = (cookieHeader: string | undefined): string | undefined => {
  return getCookie(cookieHeader, REFRESH_TOKEN_COOKIE);
};

export const hashRefreshToken = (token: string): string => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

export const generateAccessToken = (userId: string, userType: string, email: string): string => {
  return jwt.sign(
    { userId, userType, email },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions
  );
};

export const createRefreshToken = async (userId: string): Promise<string> => {
  const token = crypto.randomBytes(64).toString("hex");
  const expiresInMs = parseDurationMs(env.JWT_REFRESH_EXPIRES_IN, 30 * 24 * 60 * 60 * 1000);

  await prisma.refreshToken.create({
    data: {
      user_id: userId,
      token_hash: hashRefreshToken(token),
      expires_at: new Date(Date.now() + expiresInMs),
    },
  });

  return token;
};

export const setAuthCookies = async (
  res: Response,
  user: { id: string; user_type: string; email: string }
): Promise<void> => {
  const accessToken = generateAccessToken(user.id, user.user_type, user.email);
  const refreshToken = await createRefreshToken(user.id);

  res.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
    ...cookieBaseOptions,
    maxAge: parseDurationMs(env.JWT_EXPIRES_IN, 15 * 60 * 1000),
  });
  res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
    ...cookieBaseOptions,
    maxAge: parseDurationMs(env.JWT_REFRESH_EXPIRES_IN, 30 * 24 * 60 * 60 * 1000),
  });
};

export const clearAuthCookies = (res: Response): void => {
  res.clearCookie(ACCESS_TOKEN_COOKIE, cookieBaseOptions);
  res.clearCookie(REFRESH_TOKEN_COOKIE, cookieBaseOptions);
};
