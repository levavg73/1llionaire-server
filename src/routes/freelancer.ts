import { Router, Response, NextFunction } from "express";
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
import {
  optionalHttpsUrl,
  optionalShortText,
  optionalStringArray,
  requiredHttpsUrl,
} from "../utils/validation";

const router = Router();

// ── Zod 스키마 ──────────────────────────────────────────────

const profileSchema = z
  .object({
    display_name: z.string().trim().min(1, "활동명을 입력해 주세요.").max(50).optional(),
    profile_image_url: optionalHttpsUrl,
    headline: optionalShortText(150),
    bio: optionalShortText(2000),
    region: optionalShortText(100),
    available_regions: optionalStringArray(30, 50),
    categories: optionalStringArray(20, 50),
    styles: optionalStringArray(20, 50),
    career_years: z.number().int().min(0).max(50).optional(),
    base_price_min: z.number().int().min(0).optional(),
    base_price_max: z.number().int().min(0).optional(),
    languages: optionalStringArray(20, 50),
    script_writing_available: z.boolean().optional(),
    rehearsal_available: z.boolean().optional(),
    travel_available: z.boolean().optional(),
  })
  .superRefine((body, ctx) => {
    if (
      body.base_price_min !== undefined &&
      body.base_price_max !== undefined &&
      body.base_price_min > body.base_price_max
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["base_price_max"],
        message: "최대 기본 금액은 최소 기본 금액보다 크거나 같아야 합니다.",
      });
    }
  });

const portfolioSchema = z.object({
  portfolio_type: z.enum(["intro_video", "event_video", "audio_sample", "other"]),
  title: z.string().trim().min(1, "제목을 입력해 주세요.").max(200),
  description: optionalShortText(1000),
  media_url: requiredHttpsUrl,
  thumbnail_url: optionalHttpsUrl,
  category: optionalShortText(100),
  is_representative: z.boolean().default(false),
  is_public: z.boolean().default(true),
});

const quoteSchema = z.object({
  request_id: z.string().min(1),
  price: z.number().int().positive("금액을 입력해 주세요."),
  included_services: optionalShortText(1000),
  script_included: z.boolean().default(false),
  rehearsal_included: z.boolean().default(false),
  travel_fee_included: z.boolean().default(false),
  message: optionalShortText(2000),
  valid_until: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), "유효한 견적 유효기간을 입력해 주세요.")
    .refine((value) => new Date(value) > new Date(), "견적 유효기간은 현재 이후여야 합니다.")
    .optional(),
});

// ─── 프로필 ─────────────────────────────────────────────────

// POST /api/freelancer/profile - 등록 신청
router.post(
  "/profile",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = profileSchema.parse(req.body);

      const existing = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
      });

      if (!existing) {
        return errorResponse(res, "NOT_FOUND", "프리랜서 프로필을 찾을 수 없습니다.", [], 404);
      }

      const profile = await prisma.freelancerProfile.update({
        where: { user_id: req.user!.userId },
        data: {
          ...body,
          profile_image_url: body.profile_image_url ?? null,
          status: "pending_review",
        },
      });

      return successResponse(res, profile, "등록 신청이 완료되었습니다. 관리자 검수 후 승인됩니다.", 201);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/freelancer/profile
router.get(
  "/profile",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
        include: {
          portfolios: {
            orderBy: [{ is_representative: "desc" }, { created_at: "desc" }],
          },
        },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프로필을 찾을 수 없습니다.", [], 404);
      }

      return successResponse(res, profile);
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/freelancer/profile
router.patch(
  "/profile",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = profileSchema.parse(req.body);

      const profile = await prisma.freelancerProfile.update({
        where: { user_id: req.user!.userId },
        data: {
          ...body,
          profile_image_url: body.profile_image_url ?? undefined,
        },
      });

      return successResponse(res, profile, "프로필이 수정되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// ─── 포트폴리오 ─────────────────────────────────────────────

// POST /api/freelancer/portfolio
router.post(
  "/portfolio",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = portfolioSchema.parse(req.body);

      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프로필을 찾을 수 없습니다.", [], 404);
      }

      const portfolio = await prisma.portfolio.create({
        data: {
          ...body,
          thumbnail_url: body.thumbnail_url ?? null,
          freelancer_id: profile.id,
        },
      });

      return successResponse(res, portfolio, "포트폴리오가 등록되었습니다.", 201);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/freelancer/portfolio
router.get(
  "/portfolio",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프로필을 찾을 수 없습니다.", [], 404);
      }

      const portfolios = await prisma.portfolio.findMany({
        where: { freelancer_id: profile.id },
        orderBy: [{ is_representative: "desc" }, { created_at: "desc" }],
      });

      return successResponse(res, portfolios);
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/freelancer/portfolio/:id
router.patch(
  "/portfolio/:id",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = portfolioSchema.partial().parse(req.body);

      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프로필을 찾을 수 없습니다.", [], 404);
      }

      const existing = await prisma.portfolio.findFirst({
        where: { id: req.params.id, freelancer_id: profile.id },
      });

      if (!existing) {
        return errorResponse(res, "NOT_FOUND", "포트폴리오를 찾을 수 없습니다.", [], 404);
      }

      const portfolio = await prisma.portfolio.update({
        where: { id: req.params.id },
        data: {
          ...body,
          thumbnail_url: body.thumbnail_url ?? undefined,
        },
      });

      return successResponse(res, portfolio, "포트폴리오가 수정되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/freelancer/portfolio/:id
router.delete(
  "/portfolio/:id",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프로필을 찾을 수 없습니다.", [], 404);
      }

      const existing = await prisma.portfolio.findFirst({
        where: { id: req.params.id, freelancer_id: profile.id },
      });

      if (!existing) {
        return errorResponse(res, "NOT_FOUND", "포트폴리오를 찾을 수 없습니다.", [], 404);
      }

      await prisma.portfolio.delete({ where: { id: req.params.id } });

      return successResponse(res, null, "포트폴리오가 삭제되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// ─── 전달받은 요청 목록 ──────────────────────────────────────

// GET /api/freelancer/requests
router.get(
  "/requests",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);

      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프로필을 찾을 수 없습니다.", [], 404);
      }

      const where = { freelancer_id: profile.id };

      const [items, total] = await Promise.all([
        prisma.recommendation.findMany({
          where,
          skip,
          take: limit,
          orderBy: { created_at: "desc" },
          include: {
            request: {
              select: {
                id: true,
                event_title: true,
                event_type: true,
                event_date: true,
                region: true,
                budget_min: true,
                budget_max: true,
                status: true,
              },
            },
          },
        }),
        prisma.recommendation.count({ where }),
      ]);

      return listResponse(res, items, total, page, limit);
    } catch (err) {
      next(err);
    }
  }
);

// ─── 견적 제안 ────────────────────────────────────────────────

// POST /api/freelancer/quotes
router.post(
  "/quotes",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = quoteSchema.parse(req.body);

      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프리랜서 프로필을 찾을 수 없습니다.", [], 404);
      }

      const recommendation = await prisma.recommendation.findFirst({
        where: {
          request_id: body.request_id,
          freelancer_id: profile.id,
          status: { in: ["sent", "viewed"] },
        },
        include: { request: true },
      });

      if (!recommendation) {
        return errorResponse(
          res,
          "FORBIDDEN",
          "관리자가 전달한 요청서에만 견적을 제안할 수 있습니다.",
          [],
          403
        );
      }

      if (["canceled", "disputed", "completed", "reviewed", "booked"].includes(recommendation.request.status)) {
        return errorResponse(res, "CONFLICT", "현재 상태의 요청서에는 견적을 제안할 수 없습니다.", [], 409);
      }

      const existing = await prisma.quote.findFirst({
        where: {
          request_id: body.request_id,
          freelancer_id: profile.id,
          status: { in: ["proposed", "accepted"] },
        },
      });

      if (existing) {
        return errorResponse(res, "CONFLICT", "이미 해당 요청에 견적을 제안하셨습니다.", [], 409);
      }

      const platformFee = Math.floor(body.price * 0.1);
      const totalPrice = body.price + platformFee;

      const quote = await prisma.quote.create({
        data: {
          request_id: body.request_id,
          freelancer_id: profile.id,
          quoted_by: req.user!.userId,
          price: body.price,
          platform_fee: platformFee,
          total_price: totalPrice,
          included_services: body.included_services,
          script_included: body.script_included,
          rehearsal_included: body.rehearsal_included,
          travel_fee_included: body.travel_fee_included,
          message: body.message,
          valid_until: body.valid_until ? new Date(body.valid_until) : null,
          status: "proposed",
        },
      });

      return successResponse(res, quote, "견적이 제안되었습니다.", 201);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/freelancer/settlements
router.get(
  "/settlements",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);

      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프로필을 찾을 수 없습니다.", [], 404);
      }

      const where = { freelancer_id: profile.id };

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
            freelancer_amount: true,
            booking_status: true,
            payment_status: true,
            settlement_status: true,
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

export default router;
