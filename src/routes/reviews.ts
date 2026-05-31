import { Router, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../config/database";
import { authenticate } from "../middleware/auth";
import { requireCustomer } from "../middleware/roles";
import { AuthRequest } from "../types";
import { successResponse, errorResponse, listResponse, parsePagination } from "../utils/response";
import { canTransitionRequest } from "../utils/stateTransitions";

const router = Router();

const reviewSchema = z.object({
  booking_id: z.string().min(1),
  punctuality_score: z.number().int().min(1).max(5),
  voice_delivery_score: z.number().int().min(1).max(5),
  event_understanding_score: z.number().int().min(1).max(5),
  atmosphere_score: z.number().int().min(1).max(5),
  script_score: z.number().int().min(1).max(5),
  response_score: z.number().int().min(1).max(5),
  communication_score: z.number().int().min(1).max(5),
  rehire_intent: z.boolean(),
  comment: z.string().trim().max(2000).optional(),
});

// POST /api/reviews
router.post(
  "/",
  authenticate,
  requireCustomer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = reviewSchema.parse(req.body);

      const booking = await prisma.booking.findFirst({
        where: { id: body.booking_id, customer_id: req.user!.userId },
        include: { request: true },
      });

      if (!booking) {
        return errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
      }

      if (booking.booking_status !== "completed") {
        return errorResponse(res, "FORBIDDEN", "행사 완료 후에만 후기를 작성할 수 있습니다.", [], 403);
      }

      const existingReview = await prisma.review.findUnique({
        where: { booking_id: body.booking_id },
      });

      if (existingReview) {
        return errorResponse(res, "CONFLICT", "이미 후기를 작성하셨습니다.", [], 409);
      }

      const scores = [
        body.punctuality_score,
        body.voice_delivery_score,
        body.event_understanding_score,
        body.atmosphere_score,
        body.script_score,
        body.response_score,
        body.communication_score,
      ];
      const total_score = Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(2));

      const review = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const newReview = await tx.review.create({
          data: {
            ...body,
            comment: body.comment || null,
            total_score,
            freelancer_id: booking.freelancer_id,
            customer_id: req.user!.userId,
            status: "pending",
          },
        });

        if (booking.request && canTransitionRequest(booking.request.status, "reviewed")) {
          await tx.eventRequest.update({
            where: { id: booking.request.id },
            data: { status: "reviewed" },
          });
        }

        const stats = await tx.review.aggregate({
          where: {
            freelancer_id: booking.freelancer_id,
            status: "published",
          },
          _avg: { total_score: true },
          _count: true,
        });

        await tx.freelancerProfile.update({
          where: { id: booking.freelancer_id },
          data: {
            avg_rating: stats._avg.total_score ?? null,
            review_count: stats._count,
          },
        });

        return newReview;
      });

      return successResponse(res, review, "후기가 등록되었습니다. 검수 후 공개됩니다.", 201);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/reviews/me
router.get(
  "/me",
  authenticate,
  requireCustomer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
      const where = { customer_id: req.user!.userId };

      const [items, total] = await Promise.all([
        prisma.review.findMany({
          where,
          skip,
          take: limit,
          orderBy: { created_at: "desc" },
          include: {
            booking: { select: { event_title: true, event_date: true } },
            freelancer: { select: { display_name: true, profile_image_url: true } },
          },
        }),
        prisma.review.count({ where }),
      ]);

      return listResponse(res, items, total, page, limit);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/reviews/freelancer/:freelancerId
router.get(
  "/freelancer/:freelancerId",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
      const where = {
        freelancer_id: req.params.freelancerId,
        status: "published" as const,
      };

      const [items, total] = await Promise.all([
        prisma.review.findMany({
          where,
          skip,
          take: limit,
          orderBy: { created_at: "desc" },
        }),
        prisma.review.count({ where }),
      ]);

      return listResponse(res, items, total, page, limit);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
