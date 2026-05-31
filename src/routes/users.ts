/**
 * /api/users 전용 라우터
 * - PATCH /api/users/me  — 내 기본 정보 수정 (이름, 연락처)
 *
 * index.ts의 `app.use("/api/users", authenticate, authRoutes)` 패턴은
 * auth 라우터 전체를 재마운트하는 버그를 유발함.
 * 이 파일로 분리하여 명확하게 처리.
 */

import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import prisma from "../config/database";
import { authenticate } from "../middleware/auth";
import { AuthRequest } from "../types";
import { successResponse, errorResponse } from "../utils/response";

const router = Router();

const updateMeSchema = z.object({
  name: z.string().min(1, "이름을 입력해 주세요.").max(50).optional(),
  phone: z.string().optional(),
});

// PATCH /api/users/me
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

// GET /api/users/me — auth.ts의 /me와 동일하게 제공 (편의용)
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

export default router;
