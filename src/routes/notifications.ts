/**
 * 알림 라우터
 *
 * Vercel serverless 호환을 위해 long-lived SSE 연결은 사용하지 않습니다.
 * 알림은 DB에 저장하고, 프론트엔드는 unread-count/list API를 주기적으로 조회합니다.
 *
 * - GET    /api/notifications              — 목록
 * - GET    /api/notifications/unread-count — 미확인 수
 * - PATCH  /api/notifications/read-all     — 전체 읽음
 * - PATCH  /api/notifications/:id/read     — 개별 읽음
 * - DELETE /api/notifications/:id          — 개별 삭제
 */

import { Router, NextFunction, Response } from "express";
import prisma from "../config/database";
import { authenticate } from "../middleware/auth";
import { AuthRequest } from "../types";
import {
  successResponse,
  errorResponse,
  listResponse,
  parsePagination,
} from "../utils/response";

const router = Router();

router.use(authenticate);

// GET /api/notifications
router.get(
  "/",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip } = parsePagination(
        req.query as Record<string, unknown>
      );
      const where = { user_id: req.user!.userId };

      const [items, total, unreadCount] = await Promise.all([
        prisma.notification.findMany({
          where,
          skip,
          take: limit,
          orderBy: { created_at: "desc" },
        }),
        prisma.notification.count({ where }),
        prisma.notification.count({ where: { ...where, is_read: false } }),
      ]);

      return listResponse(
        res,
        items.map((item) => ({ ...item, unread_count: unreadCount })),
        total,
        page,
        limit
      );
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/notifications/unread-count
router.get(
  "/unread-count",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const count = await prisma.notification.count({
        where: { user_id: req.user!.userId, is_read: false },
      });
      return successResponse(res, { count });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/notifications/read-all
router.patch(
  "/read-all",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      await prisma.notification.updateMany({
        where: { user_id: req.user!.userId, is_read: false },
        data: { is_read: true },
      });
      return successResponse(res, null, "모든 알림을 읽음 처리했습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/notifications/:id/read
router.patch(
  "/:id/read",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const notification = await prisma.notification.findFirst({
        where: { id: req.params.id, user_id: req.user!.userId },
      });

      if (!notification) {
        return errorResponse(res, "NOT_FOUND", "알림을 찾을 수 없습니다.", [], 404);
      }

      const updated = await prisma.notification.update({
        where: { id: req.params.id },
        data: { is_read: true },
      });

      return successResponse(res, updated, "알림을 읽음 처리했습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/notifications/:id
router.delete(
  "/:id",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const notification = await prisma.notification.findFirst({
        where: { id: req.params.id, user_id: req.user!.userId },
      });

      if (!notification) {
        return errorResponse(res, "NOT_FOUND", "알림을 찾을 수 없습니다.", [], 404);
      }

      await prisma.notification.delete({ where: { id: req.params.id } });

      return successResponse(res, null, "알림이 삭제되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

export default router;
