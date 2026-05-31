import { Router, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../config/database";
import { authenticate } from "../middleware/auth";
import { requireCustomerOrAdmin, requireAdmin } from "../middleware/roles";
import { AuthRequest } from "../types";
import {
  successResponse,
  errorResponse,
  listResponse,
  parsePagination,
} from "../utils/response";
import { canTransitionBooking, canTransitionRequest } from "../utils/stateTransitions";

const router = Router();

// ── Zod 스키마 ──────────────────────────────────────────────

const createBookingSchema = z.object({
  request_id: z.string().min(1, "요청서를 선택해 주세요."),
  freelancer_id: z.string().min(1, "프리랜서를 선택해 주세요."),
  quote_id: z.string().optional(),
  customer_id: z.string().optional(),
});

const BLOCKED_BOOKING_REQUEST_STATUSES = ["booked", "completed", "reviewed", "canceled", "disputed"];
const BOOKING_PLATFORM_FEE_RATE = 0.1;

// ── POST /api/bookings ───────────────────────────────────────

router.post(
  "/",
  authenticate,
  requireCustomerOrAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = createBookingSchema.parse(req.body);
      const { userType, userId } = req.user!;

      const request = await prisma.eventRequest.findUnique({
        where: { id: body.request_id },
      });

      if (!request) {
        return errorResponse(res, "NOT_FOUND", "요청서를 찾을 수 없습니다.", [], 404);
      }

      if (userType === "customer" && request.customer_id !== userId) {
        return errorResponse(res, "FORBIDDEN", "본인 요청서에 대해서만 예약을 생성할 수 있습니다.", [], 403);
      }

      if (userType === "admin" && body.customer_id && body.customer_id !== request.customer_id) {
        return errorResponse(res, "VALIDATION_ERROR", "customer_id가 요청서 소유자와 일치하지 않습니다.", [], 400);
      }

      if (BLOCKED_BOOKING_REQUEST_STATUSES.includes(request.status)) {
        return errorResponse(res, "CONFLICT", "현재 상태의 요청서에는 예약을 생성할 수 없습니다.", [], 409);
      }

      const existingBooking = await prisma.booking.findFirst({
        where: {
          request_id: body.request_id,
          booking_status: { notIn: ["canceled"] },
        },
      });

      if (existingBooking) {
        return errorResponse(res, "CONFLICT", "이미 예약이 생성된 요청서입니다.", [], 409);
      }

      const recommendation = await prisma.recommendation.findFirst({
        where: {
          request_id: body.request_id,
          freelancer_id: body.freelancer_id,
          status: { in: ["sent", "viewed", "consultation_requested", "selected"] },
        },
      });

      if (!recommendation) {
        return errorResponse(res, "FORBIDDEN", "추천된 프리랜서에 대해서만 예약을 생성할 수 있습니다.", [], 403);
      }

      const quote = body.quote_id
        ? await prisma.quote.findFirst({
            where: {
              id: body.quote_id,
              request_id: body.request_id,
              freelancer_id: body.freelancer_id,
              status: { in: ["proposed", "accepted"] },
            },
          })
        : await prisma.quote.findFirst({
            where: {
              request_id: body.request_id,
              freelancer_id: body.freelancer_id,
              status: { in: ["proposed", "accepted"] },
            },
            orderBy: { created_at: "desc" },
          });

      if (!quote) {
        return errorResponse(res, "VALIDATION_ERROR", "예약 생성을 위해 유효한 견적이 필요합니다.", [], 400);
      }

      const finalPrice = quote.price;
      const platformFee = Math.floor(finalPrice * BOOKING_PLATFORM_FEE_RATE);
      const freelancerAmount = finalPrice - platformFee;

      const booking = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const created = await tx.booking.create({
          data: {
            request_id: request.id,
            customer_id: request.customer_id,
            freelancer_id: body.freelancer_id,
            quote_id: quote.id,
            event_title: request.event_title,
            event_date: request.event_date,
            start_time: request.start_time,
            end_time: request.end_time,
            venue: request.venue,
            final_price: finalPrice,
            platform_fee: platformFee,
            freelancer_amount: freelancerAmount,
            booking_status: "pending",
            payment_status: "unpaid",
            settlement_status: "pending",
          },
        });

        await tx.eventRequest.update({
          where: { id: request.id },
          data: { status: "booked" },
        });

        await tx.quote.update({
          where: { id: quote.id },
          data: { status: "accepted" },
        });

        await tx.recommendation.update({
          where: { id: recommendation.id },
          data: { status: "selected" },
        });

        return created;
      });

      return successResponse(res, booking, "예약이 생성되었습니다.", 201);
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/bookings ────────────────────────────────────────

router.get(
  "/",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
      const { userType, userId } = req.user!;

      let where: Record<string, unknown> = {};

      if (userType === "customer") {
        where = { customer_id: userId };
      } else if (userType === "freelancer") {
        const profile = await prisma.freelancerProfile.findUnique({
          where: { user_id: userId },
        });
        if (!profile) {
          return errorResponse(res, "NOT_FOUND", "프로필을 찾을 수 없습니다.", [], 404);
        }
        where = { freelancer_id: profile.id };
      }
      // admin은 전체 조회

      const [items, total] = await Promise.all([
        prisma.booking.findMany({
          where,
          skip,
          take: limit,
          orderBy: { created_at: "desc" },
          include: {
            customer: { select: { id: true, name: true } },
            freelancer: {
              select: { id: true, display_name: true, profile_image_url: true },
            },
          },
        }),
        prisma.booking.count({ where }),
      ]);

      return listResponse(res, items, total, page, limit);
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/bookings/:id ────────────────────────────────────

router.get(
  "/:id",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userType, userId } = req.user!;

      const booking = await prisma.booking.findUnique({
        where: { id: req.params.id },
        include: {
          customer: { select: { id: true, name: true } },
          freelancer: {
            select: { id: true, display_name: true, profile_image_url: true },
          },
          quote: true,
          reviews: true,
        },
      });

      if (!booking) {
        return errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
      }

      // 권한 검증: admin이 아니면 본인 예약만 조회 가능
      if (userType === "customer" && booking.customer_id !== userId) {
        return errorResponse(res, "FORBIDDEN", "접근 권한이 없습니다.", [], 403);
      }

      if (userType === "freelancer") {
        const profile = await prisma.freelancerProfile.findUnique({
          where: { user_id: userId },
        });
        if (!profile || booking.freelancer_id !== profile.id) {
          return errorResponse(res, "FORBIDDEN", "접근 권한이 없습니다.", [], 403);
        }
      }

      return successResponse(res, booking);
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /api/bookings/:id/cancel ───────────────────────────

router.patch(
  "/:id/cancel",
  authenticate,
  requireCustomerOrAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userType, userId } = req.user!;
      const { cancel_reason } = req.body;

      const booking = await prisma.booking.findUnique({
        where: { id: req.params.id },
      });

      if (!booking) {
        return errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
      }

      if (userType === "customer" && booking.customer_id !== userId) {
        return errorResponse(res, "FORBIDDEN", "접근 권한이 없습니다.", [], 403);
      }

      if (!canTransitionBooking(booking.booking_status, "canceled")) {
        return errorResponse(res, "VALIDATION_ERROR", "현재 상태에서는 예약을 취소할 수 없습니다.", [], 400);
      }

      const updated = await prisma.booking.update({
        where: { id: req.params.id },
        data: { booking_status: "canceled", cancel_reason: cancel_reason || null },
      });

      return successResponse(res, updated, "예약이 취소되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /api/bookings/:id/complete ─────────────────────────

router.patch(
  "/:id/complete",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const booking = await prisma.booking.findUnique({
        where: { id: req.params.id },
        include: { request: true },
      });

      if (!booking) {
        return errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
      }

      if (!canTransitionBooking(booking.booking_status, "completed")) {
        return errorResponse(res, "VALIDATION_ERROR", "현재 상태에서는 행사 완료 처리할 수 없습니다.", [], 400);
      }

      const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const completed = await tx.booking.update({
          where: { id: req.params.id },
          data: { booking_status: "completed" },
        });

        if (booking.request && canTransitionRequest(booking.request.status, "completed")) {
          await tx.eventRequest.update({
            where: { id: booking.request.id },
            data: { status: "completed" },
          });
        }

        return completed;
      });

      return successResponse(res, updated, "행사 완료 처리되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

export default router;
