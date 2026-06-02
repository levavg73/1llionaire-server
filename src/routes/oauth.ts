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
 * 보안/운영 포인트:
 *  - state는 HMAC 서명 + oauth_state 쿠키로 검증합니다.
 *  - Render 재시작/슬립으로 state 메모리가 사라지는 문제를 피합니다.
 *  - redirect_uri는 CLIENT_URL / CLIENT_URL_PROD origin만 허용합니다.
 *  - 카카오는 이메일 동의를 강제하지 않습니다. 이메일이 없으면 내부용 대체 이메일을 생성합니다.
 */

import { Router, Request, Response, NextFunction } from "express";
import axios from "axios";
import crypto from "crypto";
import { z } from "zod";
import prisma from "../config/database";
import { env, isProduction } from "../config/env";
import { getCookie, setAuthCookies } from "../utils/authTokens";
import { errorResponse } from "../utils/response";
import { isAllowedClientOrigin } from "../utils/origins";

const router = Router();

// ─── 타입 ────────────────────────────────────────────────────

type OAuthProvider = "kakao" | "google";
type OAuthUserType = "customer" | "freelancer";

interface OAuthUserInfo {
  providerId: string;
  email?: string;
  name: string;
}

interface OAuthDbUser {
  id: string;
  user_type: string;
  email: string;
  name: string;
}

interface OAuthUpsertResult {
  user: OAuthDbUser;
  isNew: boolean;
}

interface OAuthStatePayload {
  provider: OAuthProvider;
  userType: OAuthUserType;
  redirectUri: string;
  nonce: string;
  expiresAt: number;
}

// ─── 공통 유틸 ────────────────────────────────────────────────

const STATE_COOKIE_NAME = "oauth_state";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

const stateCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: "lax" as const,
  path: "/api/auth/oauth",
  maxAge: STATE_MAX_AGE_MS,
};

function getFrontendOrigin(): string {
  return (env.CLIENT_URL_PROD || env.CLIENT_URL).replace(/\/+$/, "");
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  return url.toString();
}

function normalizeOrigin(value: string): string {
  return new URL(value).origin;
}

function assertAllowedRedirectUri(redirectUri: string): string {
  const normalized = normalizeUrl(redirectUri).replace(/\/+$/, "");
  const origin = normalizeOrigin(normalized);

  if (!isAllowedClientOrigin(origin)) {
    throw new Error("허용되지 않은 redirect_uri입니다.");
  }

  return origin;
}

function getProviderRedirectUri(provider: OAuthProvider): string {
  const raw = provider === "kakao" ? env.KAKAO_REDIRECT_URI : env.GOOGLE_REDIRECT_URI;

  if (!raw) {
    throw new Error(`${provider} OAuth redirect URI가 설정되지 않았습니다.`);
  }

  return normalizeUrl(raw);
}

function requireProviderConfig(provider: OAuthProvider): void {
  if (provider === "kakao") {
    if (!env.KAKAO_CLIENT_ID) {
      throw new Error("KAKAO_CLIENT_ID가 설정되지 않았습니다.");
    }
    if (!env.KAKAO_REDIRECT_URI) {
      throw new Error("KAKAO_REDIRECT_URI가 설정되지 않았습니다.");
    }
    return;
  }

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID 또는 GOOGLE_CLIENT_SECRET이 설정되지 않았습니다.");
  }
  if (!env.GOOGLE_REDIRECT_URI) {
    throw new Error("GOOGLE_REDIRECT_URI가 설정되지 않았습니다.");
  }
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(value: string): string {
  return crypto.createHmac("sha256", env.JWT_SECRET).update(value).digest("base64url");
}

function createSignedState(payload: OAuthStatePayload): string {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifySignedState(state: string): OAuthStatePayload | null {
  const [encodedPayload, signature] = state.split(".");
  if (!encodedPayload || !signature) return null;

  const expected = sign(encodedPayload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    return JSON.parse(base64UrlDecode(encodedPayload)) as OAuthStatePayload;
  } catch {
    return null;
  }
}

function setOAuthStateCookie(res: Response, state: string): void {
  res.cookie(STATE_COOKIE_NAME, state, stateCookieOptions);
}

function clearOAuthStateCookie(res: Response): void {
  res.clearCookie(STATE_COOKIE_NAME, {
    httpOnly: stateCookieOptions.httpOnly,
    secure: stateCookieOptions.secure,
    sameSite: stateCookieOptions.sameSite,
    path: stateCookieOptions.path,
  });
}

function buildErrorRedirect(base: string | undefined, message: string): string {
  const safeBase = base || getFrontendOrigin();
  return `${safeBase}/login?error=${encodeURIComponent(message)}`;
}

function makeProviderFallbackEmail(provider: OAuthProvider, providerId: string): string {
  // DB schema가 email String @unique / required라서 이메일 미동의 사용자를 위한 내부 식별값입니다.
  // 실제 사용자에게 이메일로 보여주거나 메일 발송에 사용하면 안 됩니다.
  return `${provider}_${providerId}@oauth.local`;
}

function getOAuthErrorMessage(req: Request): string {
  const { error, error_description } = req.query as Record<string, string | undefined>;
  if (error_description) return `OAuth 오류: ${error_description}`;
  if (error) return `OAuth 오류: ${error}`;
  return "OAuth 인증이 취소되었거나 실패했습니다.";
}

// ─── 프로바이더별 설정 ────────────────────────────────────────

function getKakaoAuthUrl(state: string): string {
  requireProviderConfig("kakao");

  const params = new URLSearchParams({
    client_id: env.KAKAO_CLIENT_ID ?? "",
    redirect_uri: getProviderRedirectUri("kakao"),
    response_type: "code",
    state,
  });

  // 이메일/닉네임 동의를 강제하지 않습니다.
  // 특정 동의항목이 꼭 필요해지는 시점에만 scope를 추가하세요.
  // 예: params.set("scope", "profile_nickname,account_email");

  return `https://kauth.kakao.com/oauth/authorize?${params.toString()}`;
}

function getGoogleAuthUrl(state: string): string {
  requireProviderConfig("google");

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: getProviderRedirectUri("google"),
    response_type: "code",
    state,
    scope: "openid email profile",
    prompt: "select_account",
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeKakaoCode(code: string): Promise<OAuthUserInfo> {
  requireProviderConfig("kakao");

  const tokenParams = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: env.KAKAO_CLIENT_ID ?? "",
    redirect_uri: getProviderRedirectUri("kakao"),
    code,
  });

  // 카카오 앱에서 Client Secret을 활성화한 경우에만 전송합니다.
  if (env.KAKAO_CLIENT_SECRET) {
    tokenParams.set("client_secret", env.KAKAO_CLIENT_SECRET);
  }

  const tokenRes = await axios.post<{ access_token: string }>(
    "https://kauth.kakao.com/oauth/token",
    tokenParams.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" } }
  );

  const userRes = await axios.get<{
    id: number;
    kakao_account?: {
      email?: string;
      profile?: { nickname?: string };
    };
    properties?: {
      nickname?: string;
    };
  }>("https://kapi.kakao.com/v2/user/me", {
    headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
  });

  const account = userRes.data.kakao_account;
  const providerId = String(userRes.data.id);

  return {
    providerId,
    email: account?.email,
    name:
      account?.profile?.nickname ||
      userRes.data.properties?.nickname ||
      "카카오 사용자",
  };
}

async function exchangeGoogleCode(code: string): Promise<OAuthUserInfo> {
  requireProviderConfig("google");

  const tokenParams = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID ?? "",
    client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
    redirect_uri: getProviderRedirectUri("google"),
    grant_type: "authorization_code",
  });

  const tokenRes = await axios.post<{
    access_token: string;
    id_token?: string;
  }>("https://oauth2.googleapis.com/token", tokenParams.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
  });

  const userRes = await axios.get<{
    sub: string;
    email?: string;
    name?: string;
  }>("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
  });

  return {
    providerId: userRes.data.sub,
    email: userRes.data.email,
    name: userRes.data.name || "Google 사용자",
  };
}

async function upsertOAuthUser(
  provider: OAuthProvider,
  info: OAuthUserInfo,
  userType: OAuthUserType
): Promise<OAuthUpsertResult> {
  // 1. 같은 provider + providerId 찾기
  const user = await prisma.user.findFirst({
    where: { provider, provider_id: info.providerId },
    select: { id: true, user_type: true, email: true, name: true },
  });

  if (user) return { user, isNew: false };

  // 2. 이메일이 있는 경우에만 기존 이메일 계정과 연결
  if (info.email) {
    const existingByEmail = await prisma.user.findUnique({
      where: { email: info.email },
      select: { id: true, user_type: true, email: true, name: true },
    });

    if (existingByEmail) {
      const linkedUser = await prisma.user.update({
        where: { id: existingByEmail.id },
        data: { provider, provider_id: info.providerId },
        select: { id: true, user_type: true, email: true, name: true },
      });
      return { user: linkedUser, isNew: false };
    }
  }

  const email = info.email || makeProviderFallbackEmail(provider, info.providerId);

  // 3. 신규 사용자 생성
  const newUser = await prisma.user.create({
    data: {
      email,
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
    select: { id: true, user_type: true, email: true, name: true },
  });

  return { user: newUser, isNew: true };
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
      const redirectUri = assertAllowedRedirectUri(query.redirect_uri);

      const payload: OAuthStatePayload = {
        provider,
        userType: query.user_type,
        redirectUri,
        nonce: crypto.randomBytes(16).toString("hex"),
        expiresAt: Date.now() + STATE_MAX_AGE_MS,
      };

      const state = createSignedState(payload);
      setOAuthStateCookie(res, state);

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
    const { code, state } = req.query as Record<string, string | undefined>;

    try {
      if (!["kakao", "google"].includes(provider)) {
        return res.redirect(
          302,
          buildErrorRedirect(undefined, "지원하지 않는 OAuth 프로바이더입니다.")
        );
      }

      if (req.query.error) {
        clearOAuthStateCookie(res);
        return res.redirect(302, buildErrorRedirect(undefined, getOAuthErrorMessage(req)));
      }

      if (!code || !state) {
        clearOAuthStateCookie(res);
        return res.redirect(
          302,
          buildErrorRedirect(undefined, "OAuth 인증 코드 또는 state가 없습니다.")
        );
      }

      const cookieState = getCookie(req.headers.cookie, STATE_COOKIE_NAME);
      if (!cookieState || cookieState !== state) {
        clearOAuthStateCookie(res);
        return res.redirect(
          302,
          buildErrorRedirect(undefined, "OAuth state가 일치하지 않습니다. 다시 로그인해 주세요.")
        );
      }

      const payload = verifySignedState(state);
      if (!payload) {
        clearOAuthStateCookie(res);
        return res.redirect(
          302,
          buildErrorRedirect(undefined, "유효하지 않은 OAuth state입니다. 다시 로그인해 주세요.")
        );
      }

      clearOAuthStateCookie(res);

      if (payload.provider !== provider) {
        return res.redirect(
          302,
          buildErrorRedirect(payload.redirectUri, "OAuth 프로바이더 정보가 일치하지 않습니다.")
        );
      }

      if (payload.expiresAt < Date.now()) {
        return res.redirect(
          302,
          buildErrorRedirect(payload.redirectUri, "OAuth 세션이 만료되었습니다. 다시 로그인해 주세요.")
        );
      }

      const info =
        provider === "kakao"
          ? await exchangeKakaoCode(code)
          : await exchangeGoogleCode(code);

      const result = await upsertOAuthUser(provider, info, payload.userType);
      const { user } = result;

      // 쿠키 발급 (기존 이메일 로그인과 동일)
      await setAuthCookies(res, {
        id: user.id,
        user_type: user.user_type,
        email: user.email,
      });

      // 프론트엔드로 리다이렉트 - 루트로 보내고 클라이언트가 role별 리다이렉트 처리
      // ProtectedRoute의 isLoading race condition 방지
      // 신규 소셜 가입자 (이름이 기본값이면 이름 설정 페이지로)
      const needsNameSetup =
        result.isNew &&
        (!result.user.name ||
          result.user.name === "카카오 사용자" ||
          result.user.name === "Google 사용자");

      const redirectParam = needsNameSetup ? "login_success=1&setup=name" : "login_success=1";
      return res.redirect(302, `${payload.redirectUri}/?${redirectParam}`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "소셜 로그인 처리 중 오류가 발생했습니다.";

      return res.redirect(302, buildErrorRedirect(undefined, message));
    }
  }
);

export default router;
