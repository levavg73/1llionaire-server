import { Router, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../config/database";
import { authenticate } from "../middleware/auth";
import { requireAdmin } from "../middleware/roles";
import { AuthRequest } from "../types";
import {
  successResponse,
  errorResponse,
  listResponse,
  parsePagination,
} from "../utils/response";
import { canTransitionBooking, canTransitionRequest } from "../utils/stateTransitions";

const router = Router();

const freelancerStatusQuerySchema = z.object({
  status: z.enum(["draft", "pending_review", "approved", "rejected", "hidden", "suspended"]).optional(),
});

const requestStatusQuerySchema = z.object({
  status: z
    .enum([
      "submitted",
      "reviewing",
      "recommending",
      "recommended",
      "consulting",
      "booked",
      "completed",
      "reviewed",
      "canceled",
      "disputed",
    ])
    .optional(),
});

const bookingListQuerySchema = z.object({
  booking_status: z.enum(["pending", "confirmed", "completed", "canceled", "disputed"]).optional(),
  payment_status: z.enum(["unpaid", "deposit_paid", "fully_paid", "refunded", "failed"]).optional(),
});

const paymentStatusQuerySchema = z.object({
  payment_status: z.enum(["unpaid", "deposit_paid", "fully_paid", "refunded", "failed"]).optional(),
});

const settlementStatusQuerySchema = z.object({
  settlement_status: z.enum(["pending", "scheduled", "completed", "held", "failed"]).optional(),
});

const reviewStatusQuerySchema = z.object({
  status: z.enum(["pending", "published", "hidden", "reported"]).optional(),
});


// 모든 관리자 라우트에 인증 + admin 권한 요구
router.use(authenticate, requireAdmin);

// ── GET /api/admin/dashboard ─────────────────────────────────

router.get("/dashboard", async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const [
      newRequests,
      pendingRecommendation,
      pendingFreelancers,
      confirmedBookings,
      completedBookings,
      unpaidPayments,
      pendingSettlements,
      pendingReviews,
    ] = await Promise.all([
      prisma.eventRequest.count({ where: { status: "submitted" } }),
      prisma.eventRequest.count({ where: { status: { in: ["reviewing", "recommending"] } } }),
      prisma.freelancerProfile.count({ where: { status: "pending_review" } }),
      prisma.booking.count({ where: { booking_status: "confirmed" } }),
      prisma.booking.count({ where: { booking_status: "completed" } }),
      prisma.booking.count({ where: { payment_status: "unpaid" } }),
      prisma.booking.count({ where: { settlement_status: { in: ["pending", "scheduled"] } } }),
      prisma.review.count({ where: { status: "pending" } }),
    ]);

    return successResponse(res, {
      new_requests: newRequests,
      pending_recommendation: pendingRecommendation,
      pending_freelancers: pendingFreelancers,
      confirmed_bookings: confirmedBookings,
      completed_bookings: completedBookings,
      unpaid_payments: unpaidPayments,
      pending_settlements: pendingSettlements,
      pending_reviews: pendingReviews,
    });
  } catch (err) {
    next(err);
  }
});

// ── 프리랜서 관리 ─────────────────────────────────────────────

router.get("/freelancers", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
    const { status } = freelancerStatusQuerySchema.parse(req.query);

    const where = {
      ...(status && { status }),
    };

    const [items, total] = await Promise.all([
      prisma.freelancerProfile.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        include: {
          user: { select: { id: true, name: true, email: true, phone: true } },
          portfolios: { take: 1, where: { is_representative: true } },
        },
      }),
      prisma.freelancerProfile.count({ where }),
    ]);

    return listResponse(res, items, total, page, limit);
  } catch (err) {
    next(err);
  }
});

router.patch("/freelancers/:id/approve", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const profile = await prisma.freelancerProfile.findUnique({
      where: { id: req.params.id },
    });

    if (!profile) {
      return errorResponse(res, "NOT_FOUND", "프리랜서 프로필을 찾을 수 없습니다.", [], 404);
    }

    const updated = await prisma.freelancerProfile.update({
      where: { id: req.params.id },
      data: { status: "approved", approved_at: new Date(), rejected_reason: null },
    });

    return successResponse(res, updated, "프리랜서가 승인되었습니다.");
  } catch (err) {
    next(err);
  }
});

router.patch("/freelancers/:id/reject", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const rejectSchema = z.object({ reason: z.string().min(1, "반려 사유를 입력해 주세요.") });
    const { reason } = rejectSchema.parse(req.body);

    const profile = await prisma.freelancerProfile.findUnique({
      where: { id: req.params.id },
    });

    if (!profile) {
      return errorResponse(res, "NOT_FOUND", "프리랜서 프로필을 찾을 수 없습니다.", [], 404);
    }

    const updated = await prisma.freelancerProfile.update({
      where: { id: req.params.id },
      data: { status: "rejected", rejected_reason: reason },
    });

    return successResponse(res, updated, "프리랜서가 반려되었습니다.");
  } catch (err) {
    next(err);
  }
});

// ── 고객 요청서 관리 ──────────────────────────────────────────

router.get("/requests", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
    const { status } = requestStatusQuerySchema.parse(req.query);

    const where = {
      ...(status && { status }),
    };

    const [items, total] = await Promise.all([
      prisma.eventRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        include: {
          customer: { select: { id: true, name: true, email: true } },
          _count: { select: { recommendations: true } },
        },
      }),
      prisma.eventRequest.count({ where }),
    ]);

    return listResponse(res, items, total, page, limit);
  } catch (err) {
    next(err);
  }
});

router.get("/requests/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const request = await prisma.eventRequest.findUnique({
      where: { id: req.params.id },
      include: {
        customer: {
          select: { id: true, name: true, email: true, phone: true, customer_profile: true },
        },
        recommendations: {
          include: {
            freelancer: {
              select: {
                id: true,
                display_name: true,
                profile_image_url: true,
                categories: true,
                region: true,
                avg_rating: true,
              },
            },
          },
          orderBy: { display_order: "asc" },
        },
        quotes: {
          include: {
            freelancer: { select: { id: true, display_name: true } },
          },
        },
        bookings: {
          select: { id: true, booking_status: true, final_price: true },
        },
      },
    });

    if (!request) {
      return errorResponse(res, "NOT_FOUND", "요청서를 찾을 수 없습니다.", [], 404);
    }

    return successResponse(res, request);
  } catch (err) {
    next(err);
  }
});

router.patch("/requests/:id/status", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      status: z.enum([
        "submitted", "reviewing", "recommending", "recommended",
        "consulting", "booked", "completed", "reviewed", "canceled", "disputed",
      ]),
    });
    const { status } = schema.parse(req.body);

    const request = await prisma.eventRequest.findUnique({
      where: { id: req.params.id },
    });

    if (!request) {
      return errorResponse(res, "NOT_FOUND", "요청서를 찾을 수 없습니다.", [], 404);
    }

    if (!canTransitionRequest(request.status, status)) {
      return errorResponse(
        res,
        "VALIDATION_ERROR",
        `요청서 상태를 ${request.status}에서 ${status}(으)로 변경할 수 없습니다.`,
        [],
        400
      );
    }

    const updated = await prisma.eventRequest.update({
      where: { id: req.params.id },
      data: { status },
    });

    console.info("[request-status-change]", {
      request_id: req.params.id,
      admin_id: req.user!.userId,
      from: request.status,
      to: status,
      changed_at: new Date().toISOString(),
    });

    return successResponse(res, updated, "요청서 상태가 변경되었습니다.");
  } catch (err) {
    next(err);
  }
});

// ── 후보 추천 ────────────────────────────────────────────────

router.post("/recommendations", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      request_id: z.string(),
      freelancer_id: z.string(),
      recommendation_reason: z.string().optional(),
      display_order: z.number().int().min(1).max(10).default(1),
    });
    const body = schema.parse(req.body);

    const request = await prisma.eventRequest.findUnique({
      where: { id: body.request_id },
    });

    if (!request) {
      return errorResponse(res, "NOT_FOUND", "요청서를 찾을 수 없습니다.", [], 404);
    }

    const freelancer = await prisma.freelancerProfile.findFirst({
      where: { id: body.freelancer_id, status: "approved" },
    });

    if (!freelancer) {
      return errorResponse(res, "FORBIDDEN", "승인된 프리랜서만 추천할 수 있습니다.", [], 403);
    }

    const existing = await prisma.recommendation.findFirst({
      where: { request_id: body.request_id, freelancer_id: body.freelancer_id },
    });

    if (existing) {
      return errorResponse(res, "CONFLICT", "이미 해당 요청서에 추천된 프리랜서입니다.", [], 409);
    }

    if (["booked", "completed", "reviewed", "canceled", "disputed"].includes(request.status)) {
      return errorResponse(res, "CONFLICT", "현재 상태의 요청서에는 후보를 추천할 수 없습니다.", [], 409);
    }

    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const recommendation = await tx.recommendation.create({
        data: {
          ...body,
          recommended_by: req.user!.userId,
          status: "sent",
        },
      });

      await tx.eventRequest.update({
        where: { id: body.request_id },
        data: { status: "recommended" },
      });

      return recommendation;
    });

    return successResponse(res, result, "후보가 추천되었습니다.", 201);
  } catch (err) {
    next(err);
  }
});

// ── 예약 관리 ─────────────────────────────────────────────────

router.get("/bookings", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
    const { booking_status, payment_status } = bookingListQuerySchema.parse(req.query);

    const where = {
      ...(booking_status && { booking_status }),
      ...(payment_status && { payment_status }),
    };

    const [items, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        include: {
          customer: { select: { id: true, name: true, email: true } },
          freelancer: { select: { id: true, display_name: true } },
        },
      }),
      prisma.booking.count({ where }),
    ]);

    return listResponse(res, items, total, page, limit);
  } catch (err) {
    next(err);
  }
});

router.patch("/bookings/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      booking_status: z.enum(["pending", "confirmed", "completed", "canceled", "disputed"]).optional(),
      payment_status: z.enum(["unpaid", "deposit_paid", "fully_paid", "refunded", "failed"]).optional(),
      settlement_status: z.enum(["pending", "scheduled", "completed", "held", "failed"]).optional(),
      cancel_reason: z.string().optional(),
    });
    const data = schema.parse(req.body);

    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { request: true },
    });

    if (!booking) {
      return errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
    }

    if (data.booking_status && !canTransitionBooking(booking.booking_status, data.booking_status)) {
      return errorResponse(
        res,
        "VALIDATION_ERROR",
        `예약 상태를 ${booking.booking_status}에서 ${data.booking_status}(으)로 변경할 수 없습니다.`,
        [],
        400
      );
    }

    const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const changed = await tx.booking.update({
        where: { id: req.params.id },
        data,
      });

      if (data.booking_status === "completed" && booking.request && canTransitionRequest(booking.request.status, "completed")) {
        await tx.eventRequest.update({
          where: { id: booking.request.id },
          data: { status: "completed" },
        });
      }

      return changed;
    });

    if (data.booking_status) {
      console.info("[booking-status-change]", {
        booking_id: req.params.id,
        admin_id: req.user!.userId,
        from: booking.booking_status,
        to: data.booking_status,
        changed_at: new Date().toISOString(),
      });
    }

    // 후기 평균 평점 재계산 (published 후기 기준)
    if (data.booking_status === "completed") {
      const stats = await prisma.review.aggregate({
        where: { freelancer_id: updated.freelancer_id, status: "published" },
        _avg: { total_score: true },
        _count: true,
      });
      await prisma.freelancerProfile.update({
        where: { id: updated.freelancer_id },
        data: { avg_rating: stats._avg.total_score, review_count: stats._count },
      });
    }

    return successResponse(res, updated, "예약 상태가 변경되었습니다.");
  } catch (err) {
    next(err);
  }
});

// ── 결제 관리 ─────────────────────────────────────────────────

router.get("/payments", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
    const { payment_status } = paymentStatusQuerySchema.parse(req.query);

    const where = {
      ...(payment_status && { payment_status }),
    };

    const [items, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        select: {
          id: true,
          event_title: true,
          event_date: true,
          final_price: true,
          platform_fee: true,
          payment_status: true,
          booking_status: true,
          customer: { select: { name: true, email: true } },
          freelancer: { select: { display_name: true } },
        },
      }),
      prisma.booking.count({ where }),
    ]);

    return listResponse(res, items, total, page, limit);
  } catch (err) {
    next(err);
  }
});

router.patch("/payments/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      payment_status: z.enum(["unpaid", "deposit_paid", "fully_paid", "refunded", "failed"]),
    });
    const { payment_status } = schema.parse(req.body);

    const updated = await prisma.booking.update({
      where: { id: req.params.id },
      data: { payment_status },
    });

    return successResponse(res, updated, "결제 상태가 변경되었습니다.");
  } catch (err) {
    next(err);
  }
});

// ── 정산 관리 ─────────────────────────────────────────────────

router.get("/settlements", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
    const { settlement_status } = settlementStatusQuerySchema.parse(req.query);

    const where = {
      ...(settlement_status && { settlement_status }),
    };

    const [items, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        skip,
        take: limit,
        orderBy: { event_date: "desc" },
        select: {
          id: true,
          event_title: true,
          event_date: true,
          final_price: true,
          platform_fee: true,
          freelancer_amount: true,
          payment_status: true,
          settlement_status: true,
          freelancer: { select: { id: true, display_name: true } },
        },
      }),
      prisma.booking.count({ where }),
    ]);

    return listResponse(res, items, total, page, limit);
  } catch (err) {
    next(err);
  }
});

router.patch("/settlements/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      settlement_status: z.enum(["pending", "scheduled", "completed", "held", "failed"]),
    });
    const { settlement_status } = schema.parse(req.body);

    const updated = await prisma.booking.update({
      where: { id: req.params.id },
      data: { settlement_status },
    });

    return successResponse(res, updated, "정산 상태가 변경되었습니다.");
  } catch (err) {
    next(err);
  }
});

// ── 후기 관리 ─────────────────────────────────────────────────

router.get("/reviews", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
    const { status } = reviewStatusQuerySchema.parse(req.query);

    const where = {
      ...(status && { status }),
    };

    const [items, total] = await Promise.all([
      prisma.review.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        include: {
          customer: { select: { name: true, email: true } },
          freelancer: { select: { display_name: true } },
          booking: { select: { event_title: true } },
        },
      }),
      prisma.review.count({ where }),
    ]);

    return listResponse(res, items, total, page, limit);
  } catch (err) {
    next(err);
  }
});

router.patch("/reviews/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      status: z.enum(["pending", "published", "hidden", "reported"]),
    });
    const { status } = schema.parse(req.body);

    const review = await prisma.review.findUnique({ where: { id: req.params.id } });
    if (!review) {
      return errorResponse(res, "NOT_FOUND", "후기를 찾을 수 없습니다.", [], 404);
    }

    const updated = await prisma.review.update({
      where: { id: req.params.id },
      data: { status },
    });

    // 후기 공개/비공개 시 평균 평점 재계산
    if (status === "published" || status === "hidden") {
      const stats = await prisma.review.aggregate({
        where: { freelancer_id: review.freelancer_id, status: "published" },
        _avg: { total_score: true },
        _count: true,
      });
      await prisma.freelancerProfile.update({
        where: { id: review.freelancer_id },
        data: { avg_rating: stats._avg.total_score, review_count: stats._count },
      });
    }

    return successResponse(res, updated, "후기 상태가 변경되었습니다.");
  } catch (err) {
    next(err);
  }
});

export default router;
