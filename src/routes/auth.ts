import { Router, Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import prisma from "../config/database";
import { authenticate } from "../middleware/auth";
import { AuthRequest } from "../types";
import { successResponse, errorResponse } from "../utils/response";
import {
  clearAuthCookies,
  getRefreshTokenFromRequest,
  hashRefreshToken,
  setAuthCookies,
} from "../utils/authTokens";

const router = Router();

// ── Zod 스키마 ──────────────────────────────────────────────

const signupSchema = z.object({
  name: z.string().min(1, "이름을 입력해 주세요.").max(50),
  email: z.string().email("유효한 이메일 주소를 입력해 주세요."),
  password: z
    .string()
    .min(8, "비밀번호는 8자 이상이어야 합니다.")
    .regex(/[A-Z]/, "대문자를 포함해야 합니다.")
    .regex(/[0-9]/, "숫자를 포함해야 합니다."),
  user_type: z.enum(["customer", "freelancer"]),
  phone: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email("유효한 이메일을 입력해 주세요."),
  password: z.string().min(1, "비밀번호를 입력해 주세요."),
});

const passwordResetRequestSchema = z.object({
  email: z.string().email("유효한 이메일을 입력해 주세요."),
});

const updateMeSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  phone: z.string().optional(),
});

const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  user_type: true,
  phone: true,
  created_at: true,
} as const;


// ── POST /api/auth/password-reset/request ───────────────────
// 현재 프로젝트에는 이메일 발송 서비스가 아직 연결되어 있지 않습니다.
// 보안상 임시 비밀번호를 화면에 노출하지 않고, 계정 존재 여부도 노출하지 않습니다.
// SendGrid/Resend 등을 연결하면 이 라우트에서 재설정 링크 발송 로직을 붙이면 됩니다.
router.post("/password-reset/request", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = passwordResetRequestSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { email: body.email },
      select: { id: true, email: true, is_active: true },
    });

    if (user?.is_active) {
      console.log(`[password-reset] request accepted for ${user.email}`);
    }

    return successResponse(
      res,
      null,
      "계정이 존재한다면 비밀번호 재설정 안내가 발송됩니다."
    );
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/signup ───────────────────────────────────

router.post("/signup", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = signupSchema.parse(req.body);

    const existing = await prisma.user.findUnique({
      where: { email: body.email },
    });
    if (existing) {
      return errorResponse(res, "CONFLICT", "이미 사용 중인 이메일입니다.", [], 409);
    }

    const password_hash = await bcrypt.hash(body.password, 12);

    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email,
        password_hash,
        user_type: body.user_type,
        phone: body.phone,
        ...(body.user_type === "customer" && {
          customer_profile: { create: {} },
        }),
        ...(body.user_type === "freelancer" && {
          freelancer_profile: { create: {} },
        }),
      },
      select: publicUserSelect,
    });

    await setAuthCookies(res, user);

    return successResponse(
      res,
      { user, auth: { type: "httpOnlyCookie" } },
      "회원가입이 완료되었습니다.",
      201
    );
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/login ────────────────────────────────────

router.post("/login", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { email: body.email },
    });

    if (!user || !user.is_active) {
      return errorResponse(res, "UNAUTHORIZED", "이메일 또는 비밀번호가 올바르지 않습니다.", [], 401);
    }

    const valid = await bcrypt.compare(body.password, user.password_hash);
    if (!valid) {
      return errorResponse(res, "UNAUTHORIZED", "이메일 또는 비밀번호가 올바르지 않습니다.", [], 401);
    }

    await setAuthCookies(res, user);

    return successResponse(res, {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        user_type: user.user_type,
        phone: user.phone,
      },
      auth: { type: "httpOnlyCookie" },
    }, "로그인 성공");
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/refresh ──────────────────────────────────

router.post("/refresh", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refreshToken = getRefreshTokenFromRequest(req.headers.cookie);
    if (!refreshToken) {
      clearAuthCookies(res);
      return errorResponse(res, "UNAUTHORIZED", "refresh token이 없습니다.", [], 401);
    }

    const tokenHash = hashRefreshToken(refreshToken);
    const stored = await prisma.refreshToken.findFirst({
      where: {
        token_hash: tokenHash,
        revoked_at: null,
        expires_at: { gt: new Date() },
      },
      include: { user: true },
    });

    if (!stored || !stored.user.is_active) {
      clearAuthCookies(res);
      return errorResponse(res, "UNAUTHORIZED", "refresh token이 유효하지 않습니다.", [], 401);
    }

    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revoked_at: new Date() },
    });

    await setAuthCookies(res, stored.user);

    return successResponse(res, {
      user: {
        id: stored.user.id,
        name: stored.user.name,
        email: stored.user.email,
        user_type: stored.user.user_type,
        phone: stored.user.phone,
      },
      auth: { type: "httpOnlyCookie" },
    }, "토큰이 재발급되었습니다.");
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/logout ───────────────────────────────────

router.post("/logout", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refreshToken = getRefreshTokenFromRequest(req.headers.cookie);

    if (refreshToken) {
      await prisma.refreshToken.updateMany({
        where: {
          token_hash: hashRefreshToken(refreshToken),
          revoked_at: null,
        },
        data: { revoked_at: new Date() },
      });
    }

    clearAuthCookies(res);
    return successResponse(res, null, "로그아웃 되었습니다.");
  } catch (err) {
    next(err);
  }
});

// ── GET /api/auth/me ────────────────────────────────────────

router.get("/me", authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        name: true,
        email: true,
        user_type: true,
        phone: true,
        is_active: true,
        created_at: true,
        customer_profile: {
          select: {
            id: true,
            customer_type: true,
            company_name: true,
            department: true,
            manager_name: true,
          },
        },
        freelancer_profile: {
          select: {
            id: true,
            display_name: true,
            profile_image_url: true,
            headline: true,
            status: true,
            avg_rating: true,
            review_count: true,
          },
        },
      },
    });

    if (!user) {
      return errorResponse(res, "NOT_FOUND", "사용자를 찾을 수 없습니다.", [], 404);
    }

    return successResponse(res, user);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/users/me ─────────────────────────────────────

router.patch("/me", authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = updateMeSchema.parse(req.body);

    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: body,
      select: {
        id: true,
        name: true,
        email: true,
        user_type: true,
        phone: true,
        updated_at: true,
      },
    });

    return successResponse(res, user, "정보가 수정되었습니다.");
  } catch (err) {
    next(err);
  }
});

export default router;
