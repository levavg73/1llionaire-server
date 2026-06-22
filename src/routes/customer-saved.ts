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
import { attachSignedProfileImageUrl } from "../utils/profileImages";

const router = Router();

const saveFreelancerSchema = z.object({
  freelancer_id: z.string().min(1, "저장할 진행자를 선택해 주세요."),
});

const freelancerInclude = {
  freelancer: {
    select: {
      id: true,
      user_id: true,
      display_name: true,
      profile_image_url: true,
      profile_image_path: true,
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
      status: true,
      avg_rating: true,
      review_count: true,
      approved_at: true,
      rejected_reason: true,
      portfolios: {
        where: { is_public: true },
        orderBy: [{ is_representative: "desc" as const }, { created_at: "desc" as const }],
        take: 3,
      },
    },
  },
};

async function serializeSavedFreelancer<T extends { freelancer: { profile_image_path?: string | null; profile_image_url?: string | null } }>(
  item: T
) {
  return {
    ...item,
    freelancer: await attachSignedProfileImageUrl(item.freelancer),
  };
}

// GET /api/customer/saved-freelancers - 저장한 진행자 목록
router.get(
  "/",
  authenticate,
  requireCustomer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
      const where = { customer_id: req.user!.userId };

      const [items, total] = await Promise.all([
        prisma.savedFreelancer.findMany({
          where,
          skip,
          take: limit,
          orderBy: { created_at: "desc" },
          include: freelancerInclude,
        }),
        prisma.savedFreelancer.count({ where }),
      ]);

      const responseItems = await Promise.all(items.map(serializeSavedFreelancer));

      return listResponse(res, responseItems, total, page, limit);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/customer/saved-freelancers - 진행자 저장
router.post(
  "/",
  authenticate,
  requireCustomer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = saveFreelancerSchema.parse(req.body);

      const freelancer = await prisma.freelancerProfile.findFirst({
        where: { id: body.freelancer_id, status: "approved" },
        select: { id: true },
      });

      if (!freelancer) {
        return errorResponse(res, "NOT_FOUND", "저장 가능한 진행자를 찾을 수 없습니다.", [], 404);
      }

      const saved = await prisma.savedFreelancer.upsert({
        where: {
          customer_id_freelancer_id: {
            customer_id: req.user!.userId,
            freelancer_id: body.freelancer_id,
          },
        },
        update: {},
        create: {
          customer_id: req.user!.userId,
          freelancer_id: body.freelancer_id,
        },
        include: freelancerInclude,
      });

      const responseSaved = await serializeSavedFreelancer(saved);

      return successResponse(res, responseSaved, "진행자를 저장했습니다.", 201);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return errorResponse(res, "CONFLICT", "이미 저장한 진행자입니다.", [], 409);
      }

      next(err);
    }
  }
);

// DELETE /api/customer/saved-freelancers/:freelancerId - 저장 해제
router.delete(
  "/:freelancerId",
  authenticate,
  requireCustomer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      await prisma.savedFreelancer.deleteMany({
        where: {
          customer_id: req.user!.userId,
          freelancer_id: req.params.freelancerId,
        },
      });

      return successResponse(res, null, "저장한 진행자에서 삭제했습니다.");
    } catch (err) {
      next(err);
    }
  }
);

export default router;
