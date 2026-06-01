/**
 * 소셜 로그인 (OAuth 2.0)
 *
 * 지원 프로바이더: kakao | google
 *
 * 플로우:
 *  1. GET /api/auth/oauth/:provider?user_type=customer&redirect_uri=...
 *     → OAuth 제공사 인가 페이지로 리다이렉트
 *  2. GET /api/auth/oauth/:provider/callback?code=...&state=...
 *     → 토큰 교환 → 사용자 정보 조회 → DB upsert → 쿠키 발급 → 프론트 리다이렉트
 *
 * 보안:
 *  - state 파라미터로 CSRF 방어
 *  - provider_id 기반으로 소셜 계정 연결
 *  - 기존 이메일 계정과 소셜 계정이 같은 이메일이면 자동 연결
 */

import { Router, Request, Response, NextFunction } from "express";
import axios from "axios";
import crypto from "crypto";
import { z } from "zod";
import prisma from "../config/database";
import { env, isProduction } from "../config/env";
import { setAuthCookies } from "../utils/authTokens";
import { errorResponse } from "../utils/response";

const router = Router();

// ─── 타입 ────────────────────────────────────────────────────

type OAuthProvider = "kakao" | "google";

interface OAuthUserInfo {
  providerId: string;
  email: string;
  name: string;
}

// ─── state 임시 저장 (메모리, 프로덕션은 Redis 권장) ──────────
// state: { userType, redirectUri }
const pendingStates = new Map<
  string,
  { userType: "customer" | "freelancer"; redirectUri: string; expiresAt: number }
>();

// 만료된 state 정리 (10분마다)
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingStates) {
    if (val.expiresAt < now) pendingStates.delete(key);
  }
}, 10 * 60 * 1000);

// ─── 프로바이더별 설정 ────────────────────────────────────────

function getKakaoAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.KAKAO_CLIENT_ID ?? "",
    redirect_uri: env.KAKAO_REDIRECT_URI ?? "",
    response_type: "code",
    state,
    scope: "profile_nickname account_email",
  });
  return `https://kauth.kakao.com/oauth/authorize?${params.toString()}`;
}

function getGoogleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: env.GOOGLE_REDIRECT_URI ?? "",
    response_type: "code",
    state,
    scope: "openid email profile",
    access_type: "offline",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeKakaoCode(code: string): Promise<OAuthUserInfo> {
  const tokenRes = await axios.post<{
    access_token: string;
  }>(
    "https://kauth.kakao.com/oauth/token",
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.KAKAO_CLIENT_ID ?? "",
      client_secret: env.KAKAO_CLIENT_SECRET ?? "",
      redirect_uri: env.KAKAO_REDIRECT_URI ?? "",
      code,
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const userRes = await axios.get<{
    id: number;
    kakao_account?: {
      email?: string;
      profile?: { nickname?: string };
    };
  }>("https://kapi.kakao.com/v2/user/me", {
    headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
  });

  const account = userRes.data.kakao_account;
  const email = account?.email;
  const name = account?.profile?.nickname ?? "카카오 사용자";

  if (!email) {
    throw new Error(
      "카카오 계정에 이메일이 없습니다. 카카오 계정 설정에서 이메일을 허용해 주세요."
    );
  }

  return {
    providerId: String(userRes.data.id),
    email,
    name,
  };
}

async function exchangeGoogleCode(code: string): Promise<OAuthUserInfo> {
  const tokenRes = await axios.post<{
    access_token: string;
    id_token: string;
  }>("https://oauth2.googleapis.com/token", {
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    grant_type: "authorization_code",
  });

  const userRes = await axios.get<{
    sub: string;
    email: string;
    name: string;
  }>("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
  });

  return {
    providerId: userRes.data.sub,
    email: userRes.data.email,
    name: userRes.data.name,
  };
}

async function upsertOAuthUser(
  provider: OAuthProvider,
  info: OAuthUserInfo,
  userType: "customer" | "freelancer"
): Promise<{ id: string; user_type: string; email: string }> {
  // 1. 같은 provider + providerId 찾기
  let user = await prisma.user.findFirst({
    where: { provider, provider_id: info.providerId },
    select: { id: true, user_type: true, email: true },
  });

  if (user) return user;

  // 2. 같은 이메일 계정 찾기 → 소셜 연결
  const existingByEmail = await prisma.user.findUnique({
    where: { email: info.email },
    select: { id: true, user_type: true, email: true },
  });

  if (existingByEmail) {
    await prisma.user.update({
      where: { id: existingByEmail.id },
      data: { provider, provider_id: info.providerId },
    });
    return existingByEmail;
  }

  // 3. 신규 사용자 생성
  const newUser = await prisma.user.create({
    data: {
      email: info.email,
      name: info.name,
      password_hash: "", // 소셜 로그인은 비밀번호 없음
      user_type: userType,
      provider,
      provider_id: info.providerId,
      is_active: true,
      ...(userType === "customer"
        ? { customer_profile: { create: {} } }
        : { freelancer_profile: { create: {} } }),
    },
    select: { id: true, user_type: true, email: true },
  });

  return newUser;
}

// ─── 라우트 ──────────────────────────────────────────────────

const initQuerySchema = z.object({
  user_type: z.enum(["customer", "freelancer"]).default("customer"),
  redirect_uri: z.string().url("유효한 redirect_uri를 입력해 주세요."),
});

// GET /api/auth/oauth/:provider
router.get(
  "/:provider",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const provider = req.params.provider as OAuthProvider;
      if (!["kakao", "google"].includes(provider)) {
        return errorResponse(
          res,
          "VALIDATION_ERROR",
          "지원하지 않는 OAuth 프로바이더입니다.",
          [],
          400
        );
      }

      const query = initQuerySchema.parse(req.query);

      // state 생성 및 저장
      const state = crypto.randomBytes(24).toString("hex");
      pendingStates.set(state, {
        userType: query.user_type,
        redirectUri: query.redirect_uri,
        expiresAt: Date.now() + 10 * 60 * 1000, // 10분
      });

      const authUrl =
        provider === "kakao"
          ? getKakaoAuthUrl(state)
          : getGoogleAuthUrl(state);

      return res.redirect(302, authUrl);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/auth/oauth/:provider/callback
router.get(
  "/:provider/callback",
  async (req: Request, res: Response, next: NextFunction) => {
    const provider = req.params.provider as OAuthProvider;
    const { code, state, error } = req.query as Record<string, string>;

    // 프로바이더 에러
    if (error) {
      return res.redirect(
        302,
        buildErrorRedirect(
          "알 수 없음",
          `OAuth 오류: ${error}`
        )
      );
    }

    // state 검증
    const pending = pendingStates.get(state);
    if (!pending) {
      return res.redirect(
        302,
        buildErrorRedirect("알 수 없음", "유효하지 않은 state 파라미터입니다.")
      );
    }
    pendingStates.delete(state);

    if (pending.expiresAt < Date.now()) {
      return res.redirect(
        302,
        buildErrorRedirect(pending.redirectUri, "OAuth 세션이 만료되었습니다.")
      );
    }

    try {
      const info =
        provider === "kakao"
          ? await exchangeKakaoCode(code)
          : await exchangeGoogleCode(code);

      const user = await upsertOAuthUser(provider, info, pending.userType);

      // 쿠키 발급 (기존 이메일 로그인과 동일)
      await setAuthCookies(res, {
        id: user.id,
        user_type: user.user_type,
        email: user.email,
      });

      // 프론트엔드 대시보드로 리다이렉트
      const dashboardPath =
        user.user_type === "admin"
          ? "/admin"
          : user.user_type === "customer"
            ? "/customer/requests"
            : "/freelancer/profile";

      return res.redirect(302, `${pending.redirectUri}${dashboardPath}`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "소셜 로그인 처리 중 오류가 발생했습니다.";
      return res.redirect(
        302,
        buildErrorRedirect(pending.redirectUri, message)
      );
    }
  }
);

function buildErrorRedirect(base: string, message: string): string {
  const safeBase = base || (isProduction ? "https://1llionaire-client.vercel.app" : "http://localhost:3000");
  return `${safeBase}/login?error=${encodeURIComponent(message)}`;
}

export default router;
