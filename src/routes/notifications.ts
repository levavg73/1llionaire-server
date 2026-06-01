/**
 * 알림 라우터
 *
 * - GET  /api/notifications          — 목록
 * - GET  /api/notifications/unread-count — 미확인 수
 * - GET  /api/notifications/stream   — SSE 실시간 스트림
 * - PATCH /api/notifications/read-all — 전체 읽음
 * - PATCH /api/notifications/:id/read — 개별 읽음
 * - DELETE /api/notifications/:id    — 개별 삭제
 */

import { Router, Response, NextFunction, Request } from "express";
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

// ─── SSE 연결 관리 ────────────────────────────────────────────
// user_id → SSE response 맵 (메모리)
// 프로덕션에서는 Redis Pub/Sub 권장
const sseClients = new Map<string, Response>();

/**
 * 특정 사용자에게 SSE 푸시
 * notifications.ts 유틸에서 호출
 */
export function pushNotificationToUser(
  userId: string,
  payload: {
    id: string;
    type: string;
    title: string;
    message: string;
    link_url?: string | null;
    created_at: Date;
  }
): void {
  const client = sseClients.get(userId);
  if (!client) return;

  try {
    client.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // 클라이언트가 이미 끊겼을 경우 무시
    sseClients.delete(userId);
  }
}

// GET /api/notifications/stream — SSE
router.get(
  "/stream",
  (req: AuthRequest, res: Response) => {
    const userId = req.user!.userId;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Nginx 버퍼링 비활성화
    res.flushHeaders();

    // 연결 확인 ping
    res.write(`event: connected\ndata: {"userId":"${userId}"}\n\n`);

    sseClients.set(userId, res);

    // 30초마다 keep-alive ping
    const pingInterval = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(pingInterval);
      }
    }, 30_000);

    req.on("close", () => {
      clearInterval(pingInterval);
      sseClients.delete(userId);
    });
  }
);

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
