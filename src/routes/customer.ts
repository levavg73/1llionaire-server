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

const REQUEST_UPDATE_ALLOWED_STATUSES = ["submitted", "reviewing", "recommending", "recommended"];
const REQUEST_DELETE_ALLOWED_STATUSES = ["submitted", "reviewing", "recommending", "recommended", "consulting"];

function toMatchingRequest(request: {
  id: string;
  event_title?: string;
  event_type: string;
  event_date: Date;
  start_time: string;
  end_time: string;
  region: string;
  venue?: string | null;
  budget_min: number | null;
  budget_max: number | null;
  preferred_freelancer_type: string[];
  preferred_styles: string[];
  required_language: string | null;
  script_required: boolean;
  rehearsal_required: boolean;
  travel_required: boolean;
  description?: string | null;
  attachment_url?: string | null;
}) {
  return {
    id: request.id,
    event_title: request.event_title,
    event_type: request.event_type,
    event_date: request.event_date,
    start_time: request.start_time,
    end_time: request.end_time,
    region: request.region,
    venue: request.venue,
    budget_min: request.budget_min,
    budget_max: request.budget_max,
    preferred_freelancer_type: request.preferred_freelancer_type,
    preferred_styles: request.preferred_styles,
    required_language: request.required_language,
    script_required: request.script_required,
    rehearsal_required: request.rehearsal_required,
    travel_required: request.travel_required,
    description: request.description,
    attachment_url: request.attachment_url,
  };
}

const requestResponseSelect = {
  id: true,
  customer_id: true,
  event_title: true,
  event_type: true,
  event_date: true,
  start_time: true,
  end_time: true,
  region: true,
  venue: true,
  budget_min: true,
  budget_max: true,
  preferred_freelancer_type: true,
  preferred_styles: true,
  required_language: true,
  script_required: true,
  rehearsal_required: true,
  travel_required: true,
  attachment_url: true,
  description: true,
  status: true,
  created_at: true,
  updated_at: true,
} satisfies Prisma.EventRequestSelect;

type RequestResponse = Prisma.EventRequestGetPayload<{ select: typeof requestResponseSelect }>;

async function getRequestViewCounts(requestIds: string[]) {
  if (requestIds.length === 0) return new Map<string, number>();

  try {
    const rows = await prisma.$queryRaw<Array<{ id: string; view_count: number | bigint }>>(
      Prisma.sql`SELECT id, view_count FROM "event_requests" WHERE id IN (${Prisma.join(requestIds)})`
    );

    return new Map(rows.map((row) => [row.id, Number(row.view_count ?? 0)]));
  } catch (err) {
    console.warn("[request-view-count-unavailable] view_count column is not ready", err);
    return new Map<string, number>();
  }
}

async function attachRequestViewCounts<T extends { id: string }>(items: T[]) {
  const counts = await getRequestViewCounts(items.map((item) => item.id));

  return items.map((item) => ({
    ...item,
    view_count: counts.get(item.id) ?? 0,
  }));
}

async function incrementRequestViewCount(requestId: string) {
  try {
    const rows = await prisma.$queryRaw<Array<{ view_count: number | bigint }>>(
      Prisma.sql`
        UPDATE "event_requests"
        SET view_count = view_count + 1
        WHERE id = ${requestId}
        RETURNING view_count
      `
    );

    return Number(rows[0]?.view_count ?? 0);
  } catch (err) {
    console.warn("[request-view-count-increment-skipped] view_count column is not ready", err);
    return 0;
  }
}

async function runAiRecommendationsSafely(params: {
  request: RequestResponse;
  recommendedByUserId: string;
  excludedFreelancerIds?: string[];
  startingDisplayOrder?: number;
}): Promise<{ count: number; status: string; failed?: boolean }> {
  try {
    return await generateAiRecommendationsForRequest({
      request: toMatchingRequest(params.request),
      recommendedByUserId: params.recommendedByUserId,
      excludedFreelancerIds: params.excludedFreelancerIds,
      startingDisplayOrder: params.startingDisplayOrder,
    });
  } catch (err) {
    console.error("[ai-recommendation-generation-failed]", {
      request_id: params.request.id,
      err,
    });

    return {
      count: 0,
      status: params.request.status,
      failed: true,
    };
  }
}

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

      const createdRequest = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const request = await tx.eventRequest.create({
          data: {
            ...requestBody,
            event_date: eventDate,
            attachment_url: requestBody.attachment_url || null,
            customer_id: req.user!.userId,
            status: "submitted",
          },
          select: requestResponseSelect,
        });

        if (preferredFreelancers.length > 0) {
          await tx.recommendation.createMany({
            data: preferredFreelancers.map((freelancer, index) => ({
              request_id: request.id,
              freelancer_id: freelancer.id,
              recommended_by: req.user!.userId,
              recommendation_reason: `${freelancer.display_name ?? "해당 진행자"}님은 고객이 직접 지명한 우선 후보입니다.`,
              display_order: index + 1,
              status: "sent",
            })),
            skipDuplicates: true,
          });
        }

        return request;
      });

      const matching = await runAiRecommendationsSafely({
        request: createdRequest,
        recommendedByUserId: req.user!.userId,
        excludedFreelancerIds: preferredFreelancers.map((freelancer) => freelancer.id),
        startingDisplayOrder: preferredFreelancers.length + 1,
      });

      if (preferredFreelancers.length > 0 && matching.count === 0) {
        await prisma.eventRequest.update({
          where: { id: createdRequest.id },
          data: { status: "recommended" },
          select: { id: true },
        });
      }

      const finalRequest = await prisma.eventRequest.findUniqueOrThrow({
        where: { id: createdRequest.id },
        select: requestResponseSelect,
      });

      const totalRecommendationCount = matching.count + preferredFreelancers.length;
      const responseRequest = (await attachRequestViewCounts([finalRequest]))[0];

      const message = totalRecommendationCount > 0
        ? `요청서가 등록되었습니다. 조건 기반 후보 ${totalRecommendationCount}명을 바로 추천했습니다.`
        : matching.failed
          ? "요청서가 등록되었습니다. AI 후보 추천은 잠시 후 다시 생성해 주세요."
          : "요청서가 등록되었습니다. 조건에 맞는 후보를 찾는 중입니다.";

      return successResponse(res, responseRequest, message, 201);
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

      const where: Prisma.EventRequestWhereInput = {
        customer_id: req.user!.userId,
        ...(status ? { status } : { status: { not: "canceled" } }),
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
            description: true,
            status: true,
            created_at: true,
            updated_at: true,
          },
        }),
        prisma.eventRequest.count({ where }),
      ]);

      const responseItems = await attachRequestViewCounts(items);

      return listResponse(res, responseItems, total, page, limit);
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
        select: {
          ...requestResponseSelect,
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

      const viewCount = await incrementRequestViewCount(request.id);

      const responseRequest = {
        ...request,
        view_count: viewCount,
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
        select: { id: true, status: true },
      });

      if (!existing) {
        return errorResponse(res, "NOT_FOUND", "요청서를 찾을 수 없습니다.", [], 404);
      }

      if (!REQUEST_UPDATE_ALLOWED_STATUSES.includes(existing.status)) {
        return errorResponse(
          res,
          "FORBIDDEN",
          "상담, 예약, 행사 완료 또는 삭제된 요청서는 수정할 수 없습니다.",
          [],
          403
        );
      }

      const updatedRequest = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const request = await tx.eventRequest.update({
          where: { id: req.params.id },
          data: {
            ...updateBody,
            ...(updateBody.event_date && { event_date: new Date(updateBody.event_date) }),
            ...("venue" in updateBody && { venue: updateBody.venue ?? null }),
            ...("required_language" in updateBody && { required_language: updateBody.required_language ?? null }),
            ...("description" in updateBody && { description: updateBody.description ?? null }),
            ...("attachment_url" in updateBody && { attachment_url: updateBody.attachment_url ?? null }),
            status: "submitted",
          },
          select: requestResponseSelect,
        });

        await tx.recommendation.deleteMany({
          where: {
            request_id: req.params.id,
            status: { in: ["draft", "sent", "viewed", "rejected"] },
          },
        });

        return request;
      });

      const matching = await runAiRecommendationsSafely({
        request: updatedRequest,
        recommendedByUserId: req.user!.userId,
      });

      const finalRequest = await prisma.eventRequest.findUniqueOrThrow({
        where: { id: req.params.id },
        select: requestResponseSelect,
      });

      const responseRequest = (await attachRequestViewCounts([finalRequest]))[0];

      const message = matching.count > 0
        ? `요청서가 수정되었습니다. 새 조건 기준 후보 ${matching.count}명을 바로 추천했습니다.`
        : matching.failed
          ? "요청서가 수정되었습니다. AI 후보 추천은 잠시 후 다시 생성해 주세요."
          : "요청서가 수정되었습니다. 새 조건에 맞는 후보를 찾는 중입니다.";

      return successResponse(res, responseRequest, message);
    } catch (err) {
      next(err);
    }
  }
);

// ── DELETE /api/customer/requests/:id (요청서 및 관련 초안 데이터 삭제) ──

router.delete(
  "/:id",
  authenticate,
  requireCustomer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.eventRequest.findFirst({
        where: { id: req.params.id, customer_id: req.user!.userId },
        select: { id: true, status: true },
      });

      if (!existing) {
        return errorResponse(res, "NOT_FOUND", "요청서를 찾을 수 없습니다.", [], 404);
      }

      if (!REQUEST_DELETE_ALLOWED_STATUSES.includes(existing.status)) {
        return errorResponse(
          res,
          "FORBIDDEN",
          "예약 완료, 행사 완료, 후기 등록, 삭제 또는 분쟁 상태의 요청서는 삭제할 수 없습니다.",
          [],
          403
        );
      }

      const relatedBookings = await prisma.booking.findMany({
        where: { request_id: req.params.id },
        select: { id: true, booking_status: true, payment_status: true },
      });

      const protectedBooking = relatedBookings.find(
        (booking) =>
          !["pending", "negotiating", "accepted"].includes(booking.booking_status) ||
          booking.payment_status !== "unpaid"
      );

      if (protectedBooking) {
        return errorResponse(
          res,
          "FORBIDDEN",
          "결제 또는 예약이 확정된 요청서는 삭제할 수 없습니다.",
          [],
          403
        );
      }

      const relatedBookingIds = relatedBookings.map((booking) => booking.id);

      if (relatedBookingIds.length > 0) {
        const [protectedPaymentCount, reviewCount, freelancerReviewCount, protectedContractCount] = await Promise.all([
          prisma.payment.count({
            where: {
              booking_id: { in: relatedBookingIds },
              OR: [
                { status: { in: ["IN_PROGRESS", "WAITING_FOR_DEPOSIT", "DONE", "PARTIAL_CANCELED"] } },
                { payment_key: { not: null } },
                { approved_at: { not: null } },
              ],
            },
          }),
          prisma.review.count({ where: { booking_id: { in: relatedBookingIds } } }),
          prisma.freelancerReview.count({ where: { booking_id: { in: relatedBookingIds } } }),
          prisma.contract.count({
            where: {
              booking_id: { in: relatedBookingIds },
              OR: [
                { status: { not: "draft" } },
                { customer_signed_at: { not: null } },
                { freelancer_signed_at: { not: null } },
                { fully_signed_at: { not: null } },
              ],
            },
          }),
        ]);

        if (protectedPaymentCount > 0) {
          return errorResponse(
            res,
            "FORBIDDEN",
            "결제 시도 또는 결제 이력이 있는 요청서는 삭제할 수 없습니다.",
            [],
            403
          );
        }

        if (reviewCount > 0 || freelancerReviewCount > 0) {
          return errorResponse(
            res,
            "FORBIDDEN",
            "후기 이력이 있는 요청서는 삭제할 수 없습니다.",
            [],
            403
          );
        }

        if (protectedContractCount > 0) {
          return errorResponse(
            res,
            "FORBIDDEN",
            "서명 또는 계약 진행 이력이 있는 요청서는 삭제할 수 없습니다.",
            [],
            403
          );
        }
      }

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        if (relatedBookingIds.length > 0) {
          const chatRooms = await tx.chatRoom.findMany({
            where: { booking_id: { in: relatedBookingIds } },
            select: { id: true },
          });
          const chatRoomIds = chatRooms.map((room) => room.id);

          const bookingOffers = await tx.bookingOffer.findMany({
            where: { booking_id: { in: relatedBookingIds } },
            select: { id: true },
          });
          const bookingOfferIds = bookingOffers.map((offer) => offer.id);

          if (chatRoomIds.length > 0 || bookingOfferIds.length > 0) {
            await tx.chatMessage.deleteMany({
              where: {
                OR: [
                  ...(chatRoomIds.length > 0 ? [{ room_id: { in: chatRoomIds } }] : []),
                  ...(bookingOfferIds.length > 0 ? [{ offer_id: { in: bookingOfferIds } }] : []),
                ],
              },
            });
          }

          await tx.bookingOffer.deleteMany({ where: { booking_id: { in: relatedBookingIds } } });
          await tx.chatRoom.deleteMany({ where: { booking_id: { in: relatedBookingIds } } });
          await tx.contract.deleteMany({ where: { booking_id: { in: relatedBookingIds }, status: "draft" } });
          await tx.payment.deleteMany({
            where: {
              booking_id: { in: relatedBookingIds },
              status: { in: ["READY", "CANCELED", "ABORTED", "EXPIRED"] },
              payment_key: null,
              approved_at: null,
            },
          });
          await tx.booking.deleteMany({ where: { id: { in: relatedBookingIds } } });
        }

        await tx.recommendation.deleteMany({ where: { request_id: req.params.id } });
        await tx.quote.deleteMany({ where: { request_id: req.params.id } });
        await tx.eventRequest.delete({ where: { id: req.params.id } });
      });

      return successResponse(res, null, "요청서가 삭제되었습니다.");
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
        select: { id: true },
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
