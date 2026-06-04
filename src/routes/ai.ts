/**
 * AI 단가 분석 라우터 (Claude claude-sonnet-4-20250514)
 *
 * - POST /api/ai/pricing-analysis     — 단위 항목별 단가 분석 리포트 생성
 * - POST /api/ai/apply-recommendation — 관리자: AI 추천 단가를 예약에 반영
 * - PATCH /api/customer/requests/:id/apply-ai-budget — 고객 요청서 예산 반영
 *
 * SRP: AI 연동 로직만 담당
 * DIP: requireAnthropicKey()로 키 검증 분리
 */

import { Router, Response, NextFunction } from "express";
import axios from "axios";
import { z } from "zod";
import prisma from "../config/database";
import { requireAnthropicKey } from "../config/env";
import { authenticate } from "../middleware/auth";
import { requireAdmin, requireCustomerOrAdmin } from "../middleware/roles";
import { AuthRequest } from "../types";
import { successResponse, errorResponse } from "../utils/response";
import { createNotification } from "../utils/notifications";
import { NotificationType } from "../utils/notificationTypes";

const router = Router();
router.use(authenticate);

// ─── 타입 ────────────────────────────────────────────────────

export interface LineItem {
  name: string;
  description: string;
  estimated_price: number;
  reason: string;
}

export type Confidence = "high" | "medium" | "low";

export interface PricingAnalysisResult {
  event_summary: string;
  line_items: LineItem[];
  recommended_min: number;
  recommended_max: number;
  recommended_center: number;
  confidence: Confidence;
  assumptions: string[];
  caution_notes: string[];
  generated_at: string;
}

// ─── Claude API 헬퍼 ─────────────────────────────────────────

async function callClaude(prompt: string, systemPrompt: string): Promise<string> {
  const apiKey = requireAnthropicKey();

  const response = await axios.post<{
    content: Array<{ type: string; text: string }>;
  }>(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout: 30_000,
    }
  );

  const textBlock = response.data.content.find((b) => b.type === "text");
  return textBlock?.text ?? "";
}

function parsePricingJson(raw: string): PricingAnalysisResult {
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) ?? raw.match(/({[\s\S]*})/);
  const jsonStr = jsonMatch ? jsonMatch[1] : raw;
  return JSON.parse(jsonStr.trim()) as PricingAnalysisResult;
}

// ─── POST /api/ai/pricing-analysis ───────────────────────────

const pricingSchema = z.object({
  event_type: z.string().min(1).max(100),
  region: z.string().min(1).max(100),
  categories: z.array(z.string()).min(1).max(10),
  career_years_min: z.number().int().min(0).optional(),
  budget_min: z.number().int().min(0).optional(),
  budget_max: z.number().int().min(0).optional(),
  duration_hours: z.number().min(0.5).max(24).optional(),
  request_id: z.string().optional(),
});

router.post(
  "/pricing-analysis",
  requireCustomerOrAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = pricingSchema.parse(req.body);

      const stats = await prisma.freelancerProfile.aggregate({
        where: {
          status: "approved",
          categories: { hasSome: body.categories },
          ...(body.region && body.region !== "전국"
            ? { OR: [{ region: body.region }, { available_regions: { has: body.region } }] }
            : {}),
          ...(body.career_years_min !== undefined
            ? { career_years: { gte: body.career_years_min } }
            : {}),
        },
        _avg: { base_price_min: true, base_price_max: true, avg_rating: true },
        _min: { base_price_min: true },
        _max: { base_price_max: true },
        _count: true,
      });

      const marketData = {
        sample_count: stats._count,
        avg_price_min: Math.round(stats._avg.base_price_min ?? 0),
        avg_price_max: Math.round(stats._avg.base_price_max ?? 0),
        market_min: stats._min.base_price_min ?? 0,
        market_max: stats._max.base_price_max ?? 0,
        avg_rating: stats._avg.avg_rating?.toFixed(1) ?? "N/A",
      };

      const systemPrompt = `당신은 한국 행사 진행자(MC/아나운서/쇼호스트) 시장 전문 단가 분석가입니다.
제공된 시장 데이터와 요청 조건을 바탕으로 단위 항목별 적정 단가를 분석합니다.

반드시 아래 JSON 형식으로만 응답하세요:
{
  "event_summary": "<행사 조건 요약, 100자 이내>",
  "line_items": [
    {
      "name": "<항목명, 예: 사전 미팅>",
      "description": "<항목 설명, 50자 이내>",
      "estimated_price": <예상 금액 (원, 정수)>,
      "reason": "<산정 근거, 80자 이내>"
    }
  ],
  "recommended_min": <최소 추천 총액 (원, 정수)>,
  "recommended_max": <최대 추천 총액 (원, 정수)>,
  "recommended_center": <중심 추천 총액 (원, 정수)>,
  "confidence": "<high|medium|low>",
  "assumptions": ["<가정 1>", "<가정 2>"],
  "caution_notes": ["<주의사항 1>", "<주의사항 2>"],
  "generated_at": "<ISO 8601 현재 시각>"
}

프리마이크 기준 단위 항목 예시 (해당 조건에 맞게 선택):
- 사전 미팅 (20~50만원)
- 대본 검토/작성 (20~80만원)
- 리허설 참석 (10~50만원)
- 본행사 진행 (행사 핵심 비용)
- 출장/이동비 (지역별 차등)
- 외국어 진행 추가 (영어 +30%, 기타 +20%)
- 라이브커머스 상품 사전 숙지 (10~30만원)
- 현장 변수 대응 (기본 포함 또는 별도)`;

      const prompt = `
## 행사 조건
- 행사 유형: ${body.event_type}
- 지역: ${body.region}
- 분야: ${body.categories.join(", ")}
- 최소 경력: ${body.career_years_min ?? 0}년 이상
- 고객 예산: ${body.budget_min ? `${body.budget_min.toLocaleString("ko-KR")}원` : "미설정"} ~ ${body.budget_max ? `${body.budget_max.toLocaleString("ko-KR")}원` : "미설정"}
- 진행 시간: ${body.duration_hours ?? "미정"}시간

## 플랫폼 시장 데이터 (${marketData.sample_count}명 기준)
- 평균 최소 단가: ${marketData.avg_price_min.toLocaleString("ko-KR")}원
- 평균 최대 단가: ${marketData.avg_price_max.toLocaleString("ko-KR")}원
- 시장 최저가: ${marketData.market_min.toLocaleString("ko-KR")}원
- 시장 최고가: ${marketData.market_max.toLocaleString("ko-KR")}원
- 평균 평점: ${marketData.avg_rating}점

위 조건으로 단위 항목별 단가를 분석해 주세요. line_items는 해당 행사에 필요한 항목만 포함하세요.`;

      const rawResponse = await callClaude(prompt, systemPrompt);
      const analysis = parsePricingJson(rawResponse);
      analysis.generated_at = new Date().toISOString();

      // 요청서 연계: AI 단가 분석 알림
      if (body.request_id) {
        const request = await prisma.eventRequest.findFirst({
          where: { id: body.request_id },
          select: { customer_id: true, event_title: true },
        });
        if (request) {
          await createNotification(prisma, {
            user_id: request.customer_id,
            type: NotificationType.AI_PRICING_READY,
            title: "AI 단가 분석 완료",
            message: `"${request.event_title}" 행사의 적정 단가 분석이 완료되었습니다. 추천 단가: ${analysis.recommended_center.toLocaleString("ko-KR")}원`,
            link_url: `/customer/requests/${body.request_id}`,
          });
        }
      }

      return successResponse(res, { analysis, market_data: marketData });
    } catch (err) {
      if (axios.isAxiosError(err) && err.config?.url?.includes("anthropic")) {
        return errorResponse(
          res,
          "SERVER_ERROR",
          "AI 분석 서비스에 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
          [],
          503
        );
      }
      next(err);
    }
  }
);

// ─── POST /api/ai/apply-recommendation ───────────────────────
// 관리자: AI 추천 단가를 예약 금액에 반영

const applySchema = z.object({
  booking_id: z.string().min(1),
  recommended_price: z.number().int().positive(),
});

router.post(
  "/apply-recommendation",
  requireAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { booking_id, recommended_price } = applySchema.parse(req.body);

      const booking = await prisma.booking.findUnique({
        where: { id: booking_id },
        select: {
          id: true,
          booking_status: true,
          event_title: true,
          customer_id: true,
          freelancer: { select: { user_id: true } },
        },
      });

      if (!booking) {
        return errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
      }

      if (["completed", "canceled", "disputed"].includes(booking.booking_status)) {
        return errorResponse(res, "CONFLICT", "이미 완료/취소된 예약은 단가를 변경할 수 없습니다.", [], 409);
      }

      const PLATFORM_FEE_RATE = 0.1;
      const platformFee = Math.floor(recommended_price * PLATFORM_FEE_RATE);
      const freelancerAmount = recommended_price - platformFee;

      const updated = await prisma.booking.update({
        where: { id: booking_id },
        data: { final_price: recommended_price, platform_fee: platformFee, freelancer_amount: freelancerAmount },
      });

      await Promise.all([
        createNotification(prisma, {
          user_id: booking.customer_id,
          type: "booking_price_updated",
          title: "예약 단가 조정 안내",
          message: `"${booking.event_title}" 예약 단가가 AI 분석 기반으로 ${recommended_price.toLocaleString("ko-KR")}원으로 조정되었습니다.`,
          link_url: `/customer/bookings`,
        }),
        createNotification(prisma, {
          user_id: booking.freelancer.user_id,
          type: "booking_price_updated",
          title: "예약 단가 조정 안내",
          message: `"${booking.event_title}" 예약 단가가 ${recommended_price.toLocaleString("ko-KR")}원으로 조정되었습니다. (정산액: ${freelancerAmount.toLocaleString("ko-KR")}원)`,
          link_url: `/freelancer/bookings`,
        }),
      ]);

      return successResponse(res, updated, "AI 추천 단가가 반영되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// ─── PATCH /api/ai/requests/:id/apply-budget ─────────────────
// 고객: AI 분석 결과를 요청서 예산에 반영

const applyBudgetSchema = z
  .object({
    budget_min: z.number().int().min(0),
    budget_max: z.number().int().min(0),
  })
  .superRefine((body, ctx) => {
    if (body.budget_min > body.budget_max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["budget_max"],
        message: "최대 예산은 최소 예산보다 크거나 같아야 합니다.",
      });
    }
  });

router.patch(
  "/requests/:id/apply-budget",
  requireCustomerOrAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId, userType } = req.user!;
      const body = applyBudgetSchema.parse(req.body);

      const request = await prisma.eventRequest.findUnique({
        where: { id: req.params.id },
        select: { id: true, customer_id: true, event_title: true, status: true },
      });

      if (!request) {
        return errorResponse(res, "NOT_FOUND", "요청서를 찾을 수 없습니다.", [], 404);
      }

      if (userType !== "admin" && request.customer_id !== userId) {
        return errorResponse(res, "FORBIDDEN", "본인 요청서만 수정할 수 있습니다.", [], 403);
      }

      if (["booked", "completed", "canceled"].includes(request.status)) {
        return errorResponse(res, "CONFLICT", "현재 상태에서는 예산을 수정할 수 없습니다.", [], 409);
      }

      const updated = await prisma.eventRequest.update({
        where: { id: req.params.id },
        data: { budget_min: body.budget_min, budget_max: body.budget_max },
      });

      return successResponse(res, updated, "예산이 AI 분석 결과로 업데이트되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/ai/recommendation-reason ──────────────────────
// 관리자: 특정 프리랜서와 요청서 조합의 추천 사유를 AI로 자동 생성

const recReasonSchema = z.object({
  request_id: z.string().min(1),
  freelancer_id: z.string().min(1),
});

router.post(
  "/recommendation-reason",
  requireAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { request_id, freelancer_id } = recReasonSchema.parse(req.body);

      const [request, freelancer] = await Promise.all([
        prisma.eventRequest.findUnique({
          where: { id: request_id },
          select: {
            event_title: true, event_type: true, region: true,
            budget_min: true, budget_max: true,
            preferred_freelancer_type: true, preferred_styles: true,
          },
        }),
        prisma.freelancerProfile.findUnique({
          where: { id: freelancer_id },
          select: {
            display_name: true, categories: true, styles: true,
            career_years: true, region: true, avg_rating: true,
            review_count: true, base_price_min: true, base_price_max: true,
            headline: true,
          },
        }),
      ]);

      if (!request || !freelancer) {
        return errorResponse(res, "NOT_FOUND", "요청서 또는 프리랜서를 찾을 수 없습니다.", [], 404);
      }

      const systemPrompt = `당신은 행사 진행자 매칭 전문가입니다. 
고객 요청서와 진행자 프로필을 비교하여 구체적이고 설득력 있는 추천 사유를 2~3문장으로 작성합니다.
단순히 "조건에 맞다"가 아니라, 구체적인 수치(경력 연수, 평점, 카테고리 일치도)와 강점을 언급해야 합니다.
한국어로 작성하고, JSON 없이 텍스트만 반환합니다.`;

      const prompt = `
## 고객 요청서
- 행사명: ${request.event_title}
- 행사 유형: ${request.event_type}
- 지역: ${request.region}
- 예산: ${request.budget_min?.toLocaleString("ko-KR") ?? "미설정"}원 ~ ${request.budget_max?.toLocaleString("ko-KR") ?? "미설정"}원
- 희망 유형: ${request.preferred_freelancer_type.join(", ") || "제한 없음"}
- 희망 스타일: ${request.preferred_styles.join(", ") || "제한 없음"}

## 진행자 프로필
- 이름: ${freelancer.display_name}
- 분야: ${freelancer.categories.join(", ")}
- 스타일: ${freelancer.styles.join(", ")}
- 경력: ${freelancer.career_years ?? "미정"}년
- 지역: ${freelancer.region}
- 평점: ${freelancer.avg_rating?.toFixed(1) ?? "없음"}점 (${freelancer.review_count}개 후기)
- 단가: ${freelancer.base_price_min?.toLocaleString("ko-KR") ?? ""}원 ~ ${freelancer.base_price_max?.toLocaleString("ko-KR") ?? ""}원

이 진행자를 이 요청서에 추천하는 구체적인 사유를 2~3문장으로 작성해 주세요.`;

      const reason = await callClaude(prompt, systemPrompt);

      return successResponse(res, { reason: reason.trim() });
    } catch (err) {
      if (axios.isAxiosError(err) && err.config?.url?.includes("anthropic")) {
        return errorResponse(res, "SERVER_ERROR", "AI 서비스 오류가 발생했습니다.", [], 503);
      }
      next(err);
    }
  }
);

export default router;
