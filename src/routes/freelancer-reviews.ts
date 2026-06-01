/**
 * 프리랜서 → 의뢰인 리뷰 라우터
 *
 * - POST /api/freelancer-reviews        — 리뷰 작성
 * - GET  /api/freelancer-reviews/me     — 내가 작성한 리뷰 목록 (프리랜서)
 * - GET  /api/freelancer-reviews/customer/:customerId — 의뢰인의 받은 리뷰 (공개)
 * - GET  /api/freelancer-reviews/booking/:bookingId   — 특정 예약의 프리랜서 리뷰
 */

import { Router, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../config/database";
import { authenticate } from "../middleware/auth";
import { requireFreelancer } from "../middleware/roles";
import { AuthRequest } from "../types";
import {
  successResponse,
  errorResponse,
  listResponse,
  parsePagination,
} from "../utils/response";

const router = Router();
router.use(authenticate);

const reviewSchema = z.object({
  booking_id: z.string().min(1, "예약 ID가 필요합니다."),
  professionalism_score: z.number().int().min(1).max(5, "1~5 사이의 값을 입력해 주세요."),
  communication_score: z.number().int().min(1).max(5),
  payment_promptness_score: z.number().int().min(1).max(5),
  respect_score: z.number().int().min(1).max(5),
  would_work_again: z.boolean(),
  comment: z.string().trim().max(2000).optional(),
});

// ─── POST /api/freelancer-reviews ────────────────────────────

router.post(
  "/",
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = reviewSchema.parse(req.body);

      // 프리랜서 프로필 확인
      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
        select: { id: true },
      });

      if (!profile) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "프리랜서 프로필을 찾을 수 없습니다.",
          [],
          404
        );
      }

      // 해당 예약이 이 프리랜서의 것인지 확인
      const booking = await prisma.booking.findFirst({
        where: {
          id: body.booking_id,
          freelancer_id: profile.id,
        },
        select: {
          id: true,
          booking_status: true,
          customer_id: true,
          event_title: true,
        },
      });

      if (!booking) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "예약을 찾을 수 없습니다.",
          [],
          404
        );
      }

      if (booking.booking_status !== "completed") {
        return errorResponse(
          res,
          "FORBIDDEN",
          "행사 완료 후에만 후기를 작성할 수 있습니다.",
          [],
          403
        );
      }

      // 중복 방지
      const existing = await prisma.freelancerReview.findUnique({
        where: { booking_id: body.booking_id },
      });

      if (existing) {
        return errorResponse(
          res,
          "CONFLICT",
          "이미 해당 예약에 후기를 작성하셨습니다.",
          [],
          409
        );
      }

      const scores = [
        body.professionalism_score,
        body.communication_score,
        body.payment_promptness_score,
        body.respect_score,
      ];
      const total_score = Number(
        (scores.reduce((sum, s) => sum + s, 0) / scores.length).toFixed(2)
      );

      const review = await prisma.freelancerReview.create({
        data: {
          booking_id: body.booking_id,
          freelancer_id: profile.id,
          customer_id: booking.customer_id,
          professionalism_score: body.professionalism_score,
          communication_score: body.communication_score,
          payment_promptness_score: body.payment_promptness_score,
          respect_score: body.respect_score,
          total_score,
          would_work_again: body.would_work_again,
          comment: body.comment ?? null,
          status: "pending",
        },
      });

      return successResponse(
        res,
        review,
        "후기가 등록되었습니다. 검수 후 공개됩니다.",
        201
      );
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/freelancer-reviews/me ──────────────────────────
// 내가 작성한 의뢰인 리뷰 목록 (프리랜서)

router.get(
  "/me",
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip } = parsePagination(
        req.query as Record<string, unknown>
      );

      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
        select: { id: true },
      });

      if (!profile) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "프리랜서 프로필을 찾을 수 없습니다.",
          [],
          404
        );
      }

      const where = { freelancer_id: profile.id };

      const [items, total] = await Promise.all([
        prisma.freelancerReview.findMany({
          where,
          skip,
          take: limit,
          orderBy: { created_at: "desc" },
          include: {
            customer: { select: { name: true } },
            booking: { select: { event_title: true, event_date: true } },
          },
        }),
        prisma.freelancerReview.count({ where }),
      ]);

      return listResponse(res, items, total, page, limit);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/freelancer-reviews/customer/:customerId ────────
// 특정 의뢰인이 받은 프리랜서 리뷰 목록 (공개, published만)

router.get(
  "/customer/:customerId",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip } = parsePagination(
        req.query as Record<string, unknown>
      );

      const where = {
        customer_id: req.params.customerId,
        status: "published" as const,
      };

      const [items, total] = await Promise.all([
        prisma.freelancerReview.findMany({
          where,
          skip,
          take: limit,
          orderBy: { created_at: "desc" },
          select: {
            id: true,
            total_score: true,
            professionalism_score: true,
            communication_score: true,
            payment_promptness_score: true,
            respect_score: true,
            would_work_again: true,
            comment: true,
            created_at: true,
            freelancer: {
              select: { display_name: true },
            },
            booking: {
              select: { event_title: true, event_date: true },
            },
          },
        }),
        prisma.freelancerReview.count({ where }),
      ]);

      return listResponse(res, items, total, page, limit);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/freelancer-reviews/booking/:bookingId ──────────

router.get(
  "/booking/:bookingId",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const review = await prisma.freelancerReview.findUnique({
        where: { booking_id: req.params.bookingId },
        include: {
          freelancer: { select: { display_name: true } },
          customer: { select: { name: true } },
        },
      });

      if (!review) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "해당 예약의 프리랜서 후기가 없습니다.",
          [],
          404
        );
      }

      // 본인 또는 관련 당사자만 조회 가능
      const { userId, userType } = req.user!;
      const isAdmin = userType === "admin";
      const isCustomer = review.customer_id === userId;

      const freelancerProfile = await prisma.freelancerProfile.findUnique({
        where: { id: review.freelancer_id },
        select: { user_id: true },
      });
      const isFreelancer = freelancerProfile?.user_id === userId;

      if (!isAdmin && !isCustomer && !isFreelancer) {
        return errorResponse(res, "FORBIDDEN", "접근 권한이 없습니다.", [], 403);
      }

      return successResponse(res, review);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
