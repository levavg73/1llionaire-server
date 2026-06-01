import { Router, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import prisma from "../config/database";
import { authenticate } from "../middleware/auth";
import { AuthRequest } from "../types";
import { successResponse, errorResponse } from "../utils/response";
import { clearAuthCookies } from "../utils/authTokens";

const router = Router();

const updateMeSchema = z.object({
  name: z.string().min(1, "이름을 입력해 주세요.").max(50).optional(),
  phone: z.string().optional(),
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1, "현재 비밀번호를 입력해 주세요."),
  new_password: z
    .string()
    .min(8, "새 비밀번호는 8자 이상이어야 합니다.")
    .regex(/[A-Z]/, "대문자를 포함해야 합니다.")
    .regex(/[0-9]/, "숫자를 포함해야 합니다."),
});

const deleteAccountSchema = z.object({
  password: z.string().min(1, "비밀번호를 입력해 주세요."),
});

// ── GET /api/users/me ────────────────────────────────────────

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

// ── PATCH /api/users/me — 기본 정보 수정 ────────────────────

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

// ── PATCH /api/users/me/password — 비밀번호 변경 ────────────

router.patch(
  "/me/password",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = changePasswordSchema.parse(req.body);

      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { id: true, password_hash: true },
      });

      if (!user) {
        return errorResponse(res, "NOT_FOUND", "사용자를 찾을 수 없습니다.", [], 404);
      }

      // 현재 비밀번호 검증
      const isValid = await bcrypt.compare(body.current_password, user.password_hash);
      if (!isValid) {
        return errorResponse(res, "UNAUTHORIZED", "현재 비밀번호가 올바르지 않습니다.", [], 401);
      }

      // 새 비밀번호가 현재와 동일한지 확인
      const isSame = await bcrypt.compare(body.new_password, user.password_hash);
      if (isSame) {
        return errorResponse(
          res,
          "CONFLICT",
          "새 비밀번호는 현재 비밀번호와 달라야 합니다.",
          [],
          409
        );
      }

      const new_hash = await bcrypt.hash(body.new_password, 12);

      await prisma.$transaction([
        // 비밀번호 업데이트
        prisma.user.update({
          where: { id: req.user!.userId },
          data: { password_hash: new_hash },
        }),
        // 기존 refresh token 전부 폐기 (다른 기기 세션 차단)
        prisma.refreshToken.updateMany({
          where: { user_id: req.user!.userId, revoked_at: null },
          data: { revoked_at: new Date() },
        }),
      ]);

      clearAuthCookies(res);

      return successResponse(res, null, "비밀번호가 변경되었습니다. 다시 로그인해 주세요.");
    } catch (err) {
      next(err);
    }
  }
);

// ── DELETE /api/users/me — 회원 탈퇴 ────────────────────────

router.delete(
  "/me",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = deleteAccountSchema.parse(req.body);

      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { id: true, password_hash: true, user_type: true },
      });

      if (!user) {
        return errorResponse(res, "NOT_FOUND", "사용자를 찾을 수 없습니다.", [], 404);
      }

      // 관리자 계정 탈퇴 금지
      if (user.user_type === "admin") {
        return errorResponse(res, "FORBIDDEN", "관리자 계정은 탈퇴할 수 없습니다.", [], 403);
      }

      // 비밀번호 확인
      const isValid = await bcrypt.compare(body.password, user.password_hash);
      if (!isValid) {
        return errorResponse(res, "UNAUTHORIZED", "비밀번호가 올바르지 않습니다.", [], 401);
      }

      // 진행 중인 예약 확인
      const activeBooking = await prisma.booking.findFirst({
        where: {
          OR: [
            { customer_id: user.id },
            {
              freelancer: { user_id: user.id },
            },
          ],
          booking_status: { in: ["pending", "confirmed"] },
        },
      });

      if (activeBooking) {
        return errorResponse(
          res,
          "CONFLICT",
          "진행 중인 예약이 있어 탈퇴할 수 없습니다. 예약 완료 또는 취소 후 다시 시도해 주세요.",
          [],
          409
        );
      }

      // Soft delete: is_active = false + 이메일 익명화 + refresh token 폐기
      const anonymizedEmail = `deleted_${user.id}@freemic.deleted`;

      await prisma.$transaction([
        prisma.user.update({
          where: { id: user.id },
          data: {
            is_active: false,
            email: anonymizedEmail,
            password_hash: "",
            name: "탈퇴한 회원",
            phone: null,
          },
        }),
        prisma.refreshToken.updateMany({
          where: { user_id: user.id, revoked_at: null },
          data: { revoked_at: new Date() },
        }),
      ]);

      clearAuthCookies(res);

      return successResponse(res, null, "회원 탈퇴가 완료되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

export default router;
