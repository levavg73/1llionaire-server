import { Router, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../config/database";
import { authenticate } from "../middleware/auth";
import { requireCustomer } from "../middleware/roles";
import { AuthRequest } from "../types";
import {
  successResponse,
  errorResponse,
  listResponse,
  parsePagination,
} from "../utils/response";
import { generateAiRecommendationsForRequest } from "../services/aiMatching";
import { attachSignedProfileImageUrl } from "../utils/profileImages";
import {
  eventDateString,
  optionalHttpsUrl,
  optionalShortText,
  requestStatusQuerySchema,
  stringArray,
  timeHHmm,
} from "../utils/validation";

const router = Router();

// ── Zod 스키마 ──────────────────────────────────────────────

const requestBaseSchema = z.object({
  event_title: z.string().trim().min(1, "행사명을 입력해 주세요.").max(200),
  event_type: z.string().trim().min(1, "행사 종류를 선택해 주세요.").max(100),
  event_date: eventDateString,
  start_time: timeHHmm,
  end_time: timeHHmm,
  region: z.string().trim().min(1, "지역을 입력해 주세요.").max(100),
  venue: optionalShortText(200),
  budget_min: z.number().int().positive().optional(),
  budget_max: z.number().int().positive().optional(),
  preferred_freelancer_type: stringArray(20, 50),
  preferred_styles: stringArray(20, 50),
  preferred_freelancer_ids: stringArray(5, 100),
  required_language: optionalShortText(50),
  script_required: z.boolean().default(false),
  rehearsal_required: z.boolean().default(false),
  travel_required: z.boolean().default(false),
  attachment_url: optionalHttpsUrl,
  description: optionalShortText(3000),
});

const validateRequestRanges = (
  body: { budget_min?: number; budget_max?: number; start_time?: string; end_time?: string },
  ctx: z.RefinementCtx
) => {
  if (body.budget_min && body.budget_max && body.budget_min > body.budget_max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budget_max"],
      message: "최대 예산은 최소 예산보다 크거나 같아야 합니다.",
    });
  }

  if (body.start_time && body.end_time && body.start_time >= body.end_time) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["end_time"],
      message: "종료 시간은 시작 시간보다 뒤여야 합니다.",
    });
  }
};

const createRequestSchema = requestBaseSchema.superRefine(validateRequestRanges);
const updateRequestSchema = requestBaseSchema.partial().superRefine(validateRequestRanges);

// ── POST /api/customer/requests ─────────────────────────────

router.post(
  "/",
  authenticate,
  requireCustomer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = createRequestSchema.parse(req.body);
      const { preferred_freelancer_ids, ...requestBody } = body;
      const uniquePreferredFreelancerIds = [...new Set(preferred_freelancer_ids ?? [])];
      const eventDate = new Date(requestBody.event_date);

      const preferredFreelancers = uniquePreferredFreelancerIds.length > 0
        ? await prisma.freelancerProfile.findMany({
            where: { id: { in: uniquePreferredFreelancerIds }, status: "approved" },
            select: { id: true, display_name: true },
          })
        : [];

      if (preferredFreelancers.length !== uniquePreferredFreelancerIds.length) {
        return errorResponse(
          res,
          "VALIDATION_ERROR",
          "지명한 진행자를 찾을 수 없거나 현재 예약 요청이 불가능합니다.",
          [],
          400
        );
      }

      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const request = await tx.eventRequest.create({
          data: {
            ...requestBody,
            event_date: eventDate,
            attachment_url: requestBody.attachment_url || null,
            customer_id: req.user!.userId,
            status: "submitted",
          },
        });

        if (preferredFreelancers.length > 0) {
          await tx.recommendation.createMany({
            data: preferredFreelancers.map((freelancer, index) => ({
              request_id: request.id,
              freelancer_id: freelancer.id,
              recommended_by: req.user!.userId,
              recommendation_reason: `${freelancer.display_name ?? "해당 진행자"}님은 고객이 직접 지명한 우선 검토 후보입니다. 관리자 검수 후 고객에게 공개됩니다.`,
              display_order: index + 1,
              status: "draft",
            })),
            skipDuplicates: true,
          });
        }

        const matching = await generateAiRecommendationsForRequest({
          tx,
          request: {
            id: request.id,
            event_type: request.event_type,
            event_date: request.event_date,
            start_time: request.start_time,
            end_time: request.end_time,
            region: request.region,
            budget_min: request.budget_min,
            budget_max: request.budget_max,
            preferred_freelancer_type: request.preferred_freelancer_type,
            preferred_styles: request.preferred_styles,
            required_language: request.required_language,
            script_required: request.script_required,
            rehearsal_required: request.rehearsal_required,
            travel_required: request.travel_required,
          },
          recommendedByUserId: req.user!.userId,
          excludedFreelancerIds: preferredFreelancers.map((freelancer) => freelancer.id),
          startingDisplayOrder: preferredFreelancers.length + 1,
        });

        if (preferredFreelancers.length > 0 && matching.count === 0) {
          await tx.eventRequest.update({
            where: { id: request.id },
            data: { status: "recommending" },
          });
        }

        const finalRequest = await tx.eventRequest.findUniqueOrThrow({ where: { id: request.id } });

        return {
          request: finalRequest,
          matching: {
            ...matching,
            count: matching.count + preferredFreelancers.length,
            preferred_count: preferredFreelancers.length,
          },
        };
      });

      const message = result.matching.count > 0
        ? `요청서가 등록되었습니다. 조건 기반 후보 초안 ${result.matching.count}명을 만들었으며 관리자 검수 후 공개됩니다.`
        : "요청서가 등록되었습니다. 관리자가 조건에 맞는 후보를 확인 중입니다.";

      return successResponse(res, result.request, message, 201);
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/customer/requests ──────────────────────────────

router.get(
  "/",
  authenticate,
  requireCustomer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
      const { status } = requestStatusQuerySchema.parse(req.query);

      const where = {
        customer_id: req.user!.userId,
        ...(status && { status }),
      };

      const [items, total] = await Promise.all([
        prisma.eventRequest.findMany({
          where,
          skip,
          take: limit,
          orderBy: { created_at: "desc" },
          select: {
            id: true,
            event_title: true,
            event_type: true,
            event_date: true,
            region: true,
            status: true,
            created_at: true,
            updated_at: true,
          },
        }),
        prisma.eventRequest.count({ where }),
      ]);

      return listResponse(res, items, total, page, limit);
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/customer/requests/:id ──────────────────────────

router.get(
  "/:id",
  authenticate,
  requireCustomer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const request = await prisma.eventRequest.findFirst({
        where: {
          id: req.params.id,
          customer_id: req.user!.userId,
        },
        include: {
          recommendations: {
            include: {
              freelancer: {
                select: {
                  id: true,
                  display_name: true,
                  profile_image_url: true,
                  profile_image_path: true,
                  headline: true,
                  categories: true,
                  region: true,
                  career_years: true,
                  base_price_min: true,
                  base_price_max: true,
                  avg_rating: true,
                  review_count: true,
                  portfolios: {
                    where: { is_representative: true, is_public: true },
                    take: 1,
                  },
                },
              },
            },
            orderBy: { display_order: "asc" },
          },
        },
      });

      if (!request) {
        return errorResponse(res, "NOT_FOUND", "요청서를 찾을 수 없습니다.", [], 404);
      }

      const responseRequest = {
        ...request,
        recommendations: await Promise.all(
          request.recommendations.map(async (recommendation) => ({
            ...recommendation,
            freelancer: await attachSignedProfileImageUrl(recommendation.freelancer),
          }))
        ),
      };

      return successResponse(res, responseRequest);
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /api/customer/requests/:id ────────────────────────

router.patch(
  "/:id",
  authenticate,
  requireCustomer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = updateRequestSchema.parse(req.body);
      const { preferred_freelancer_ids: _preferredFreelancerIds, ...updateBody } = body;

      const existing = await prisma.eventRequest.findFirst({
        where: { id: req.params.id, customer_id: req.user!.userId },
      });

      if (!existing) {
        return errorResponse(res, "NOT_FOUND", "요청서를 찾을 수 없습니다.", [], 404);
      }

      // submitted 또는 reviewing 상태만 수정 가능
      if (!["submitted", "reviewing"].includes(existing.status)) {
        return errorResponse(res, "FORBIDDEN", "현재 상태에서는 수정할 수 없습니다.", [], 403);
      }

      const updated = await prisma.eventRequest.update({
        where: { id: req.params.id },
        data: {
          ...updateBody,
          ...(updateBody.event_date && { event_date: new Date(updateBody.event_date) }),
          ...("attachment_url" in updateBody && { attachment_url: updateBody.attachment_url ?? null }),
        },
      });

      return successResponse(res, updated, "요청서가 수정되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// ── DELETE /api/customer/requests/:id (상태 변경으로 soft delete) ──

router.delete(
  "/:id",
  authenticate,
  requireCustomer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.eventRequest.findFirst({
        where: { id: req.params.id, customer_id: req.user!.userId },
      });

      if (!existing) {
        return errorResponse(res, "NOT_FOUND", "요청서를 찾을 수 없습니다.", [], 404);
      }

      if (["booked", "completed"].includes(existing.status)) {
        return errorResponse(res, "FORBIDDEN", "예약 완료 상태의 요청서는 취소할 수 없습니다.", [], 403);
      }

      await prisma.eventRequest.update({
        where: { id: req.params.id },
        data: { status: "canceled" },
      });

      return successResponse(res, null, "요청서가 취소되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/customer/requests/:id/recommendations ──────────

router.get(
  "/:id/recommendations",
  authenticate,
  requireCustomer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const request = await prisma.eventRequest.findFirst({
        where: { id: req.params.id, customer_id: req.user!.userId },
      });

      if (!request) {
        return errorResponse(res, "NOT_FOUND", "요청서를 찾을 수 없습니다.", [], 404);
      }

      const recommendations = await prisma.recommendation.findMany({
        where: {
          request_id: req.params.id,
          status: { in: ["sent", "viewed", "consultation_requested", "selected", "rejected"] },
        },
        orderBy: { display_order: "asc" },
        include: {
          freelancer: {
            select: {
              id: true,
              display_name: true,
              profile_image_url: true,
              profile_image_path: true,
              headline: true,
              categories: true,
              styles: true,
              region: true,
              career_years: true,
              base_price_min: true,
              base_price_max: true,
              languages: true,
              avg_rating: true,
              review_count: true,
              portfolios: {
                where: { is_public: true },
                orderBy: [{ is_representative: "desc" }, { created_at: "desc" }],
                take: 3,
              },
            },
          },
        },
      });

      // 후보 조회 시 상태를 viewed로 업데이트
      await prisma.recommendation.updateMany({
        where: {
          request_id: req.params.id,
          status: "sent",
        },
        data: { status: "viewed" },
      });

      const responseRecommendations = await Promise.all(
        recommendations.map(async (recommendation) => ({
          ...recommendation,
          freelancer: await attachSignedProfileImageUrl(recommendation.freelancer),
        }))
      );

      return successResponse(res, responseRecommendations);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
