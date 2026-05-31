import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import prisma from "../config/database";
import { successResponse, listResponse, parsePagination, errorResponse } from "../utils/response";
import { setPublicCache } from "../utils/cache";

const router = Router();

const freelancerListQuerySchema = z
  .object({
    category: z.string().trim().min(1).max(50).optional(),
    region: z.string().trim().min(1).max(100).optional(),
    language: z.string().trim().min(1).max(50).optional(),
    min_price: z.coerce.number().int().min(0).optional(),
    max_price: z.coerce.number().int().min(0).optional(),
    q: z.string().trim().min(1).max(100).optional(),
  })
  .superRefine((query, ctx) => {
    if (query.min_price !== undefined && query.max_price !== undefined && query.min_price > query.max_price) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max_price"],
        message: "최대 금액은 최소 금액보다 크거나 같아야 합니다.",
      });
    }
  });


// GET /api/public/freelancers - 승인된 진행자 목록
router.get(
  "/freelancers",
  setPublicCache,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
      const { category, region, language, min_price, max_price, q } = freelancerListQuerySchema.parse(req.query);

      const where: Record<string, unknown> = {
        status: "approved",
        ...(category && { categories: { has: String(category) } }),
        ...(region && { region: String(region) }),
        ...(language && { languages: { has: String(language) } }),
        ...(min_price !== undefined && { base_price_max: { gte: min_price } }),
        ...(max_price !== undefined && { base_price_min: { lte: max_price } }),
        ...(q && {
          OR: [
            { display_name: { contains: q, mode: "insensitive" } },
            { headline: { contains: q, mode: "insensitive" } },
            { bio: { contains: q, mode: "insensitive" } },
          ],
        }),
      };

      const [items, total] = await Promise.all([
        prisma.freelancerProfile.findMany({
          where,
          skip,
          take: limit,
          orderBy: [{ avg_rating: "desc" }, { review_count: "desc" }],
          select: {
            id: true,
            display_name: true,
            profile_image_url: true,
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
              where: { is_representative: true, is_public: true },
              take: 1,
              select: {
                id: true,
                portfolio_type: true,
                title: true,
                media_url: true,
                thumbnail_url: true,
              },
            },
          },
        }),
        prisma.freelancerProfile.count({ where }),
      ]);

      return listResponse(res, items, total, page, limit);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/public/freelancers/:id - 진행자 상세
router.get(
  "/freelancers/:id",
  setPublicCache,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const profile = await prisma.freelancerProfile.findFirst({
        where: { id: req.params.id, status: "approved" },
        select: {
          id: true,
          display_name: true,
          profile_image_url: true,
          headline: true,
          bio: true,
          region: true,
          available_regions: true,
          categories: true,
          styles: true,
          career_years: true,
          base_price_min: true,
          base_price_max: true,
          languages: true,
          script_writing_available: true,
          rehearsal_available: true,
          travel_available: true,
          avg_rating: true,
          review_count: true,
          approved_at: true,
          // 민감 정보 제외: email, phone, account
          portfolios: {
            where: { is_public: true },
            orderBy: [{ is_representative: "desc" }, { created_at: "desc" }],
            select: {
              id: true,
              portfolio_type: true,
              title: true,
              description: true,
              media_url: true,
              thumbnail_url: true,
              category: true,
              is_representative: true,
            },
          },
        },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "진행자를 찾을 수 없습니다.", [], 404);
      }

      return successResponse(res, profile);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/public/reviews/freelancer/:id - 진행자 후기 목록
router.get(
  "/reviews/freelancer/:id",
  setPublicCache,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);

      const where = {
        freelancer_id: req.params.id,
        status: "published" as const,
      };

      const [items, total] = await Promise.all([
        prisma.review.findMany({
          where,
          skip,
          take: limit,
          orderBy: { created_at: "desc" },
          select: {
            id: true,
            punctuality_score: true,
            voice_delivery_score: true,
            event_understanding_score: true,
            atmosphere_score: true,
            script_score: true,
            response_score: true,
            communication_score: true,
            total_score: true,
            rehire_intent: true,
            comment: true,
            created_at: true,
            customer: {
              select: { name: true },
            },
            booking: {
              select: { event_title: true, event_date: true },
            },
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

export default router;
