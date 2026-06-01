/**
 * AI 단가 분석 라우터 (Claude claude-sonnet-4-20250514)
 *
 * - POST /api/ai/pricing-analysis     — 단가 분석 리포트 생성
 * - POST /api/ai/apply-recommendation — 관리자: AI 추천 단가를 예약에 반영
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

interface PricingAnalysis {
  recommended_min: number;
  recommended_max: number;
  recommended_center: number;
  confidence: "high" | "medium" | "low";
  rationale: string;
  market_context: string;
  factors: string[];
  risk_notes: string[];
  generated_at: string;
}

// ─── Claude API 호출 헬퍼 ─────────────────────────────────────

async function callClaude(prompt: string, systemPrompt: string): Promise<string> {
  const apiKey = requireAnthropicKey();

  const response = await axios.post<{
    content: Array<{ type: string; text: string }>;
  }>(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
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

function parsePricingJson(raw: string): PricingAnalysis {
  // JSON 블록 추출 (```json ... ``` 또는 순수 JSON)
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) ?? raw.match(/({[\s\S]*})/);
  const jsonStr = jsonMatch ? jsonMatch[1] : raw;
  return JSON.parse(jsonStr.trim()) as PricingAnalysis;
}

// ─── POST /api/ai/pricing-analysis ───────────────────────────

const pricingSchema = z.object({
  event_type: z.string().min(1).max(100),
  region: z.string().min(1).max(100),
  categories: z.array(z.string()).min(1).max(10),
  career_years_min: z.number().int().min(0).optional(),
  career_years_max: z.number().int().min(0).optional(),
  budget_min: z.number().int().min(0).optional(),
  budget_max: z.number().int().min(0).optional(),
  duration_hours: z.number().min(0.5).max(24).optional(),
  request_id: z.string().optional(), // 특정 요청서와 연계 시
});

router.post(
  "/pricing-analysis",
  requireCustomerOrAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = pricingSchema.parse(req.body);

      // 유사 프리랜서 통계 (DB에서 실제 데이터 기반)
      const stats = await prisma.freelancerProfile.aggregate({
        where: {
          status: "approved",
          categories: { hasSome: body.categories },
          ...(body.region && body.region !== "전국"
            ? {
                OR: [
                  { region: body.region },
                  { available_regions: { has: body.region } },
                ],
              }
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
제공된 시장 데이터와 요청 조건을 바탕으로 적정 단가를 분석합니다.
반드시 아래 JSON 형식으로만 응답하세요:
{
  "recommended_min": <최소 추천 금액 (원, 정수)>,
  "recommended_max": <최대 추천 금액 (원, 정수)>,
  "recommended_center": <중심 추천 금액 (원, 정수)>,
  "confidence": "<high|medium|low>",
  "rationale": "<150자 이내 한국어 핵심 근거>",
  "market_context": "<100자 이내 시장 현황>",
  "factors": ["<가격 영향 요인 1>", "<요인 2>", "<요인 3>"],
  "risk_notes": ["<주의사항 1>", "<주의사항 2>"],
  "generated_at": "<ISO 8601 현재 시각>"
}`;

      const prompt = `
## 행사 조건
- 행사 유형: ${body.event_type}
- 지역: ${body.region}
- 분야: ${body.categories.join(", ")}
- 경력: ${body.career_years_min ?? 0}년 ~ ${body.career_years_max ?? "제한없음"}년
- 예산 범위: ${body.budget_min ? `${body.budget_min.toLocaleString("ko-KR")}원` : "미설정"} ~ ${body.budget_max ? `${body.budget_max.toLocaleString("ko-KR")}원` : "미설정"}
- 진행 시간: ${body.duration_hours ?? "미정"}시간

## 플랫폼 실제 시장 데이터
- 유사 프리랜서 수: ${marketData.sample_count}명
- 평균 최소 단가: ${marketData.avg_price_min.toLocaleString("ko-KR")}원
- 평균 최대 단가: ${marketData.avg_price_max.toLocaleString("ko-KR")}원
- 시장 최저가: ${marketData.market_min.toLocaleString("ko-KR")}원
- 시장 최고가: ${marketData.market_max.toLocaleString("ko-KR")}원
- 평균 평점: ${marketData.avg_rating}점

위 조건과 데이터를 바탕으로 적정 단가를 분석해 주세요.`;

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

      return successResponse(res, {
        analysis,
        market_data: marketData,
      });
    } catch (err) {
      // Anthropic API 에러 구분
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
// 관리자: AI 추천 단가를 특정 예약의 final_price에 반영

const applySchema = z.object({
  booking_id: z.string().min(1),
  recommended_price: z.number().int().positive("추천 단가를 입력해 주세요."),
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
          final_price: true,
          event_title: true,
          customer_id: true,
          freelancer: { select: { user_id: true } },
        },
      });

      if (!booking) {
        return errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
      }

      // 결제 완료 후에는 변경 불가
      if (["completed", "canceled", "disputed"].includes(booking.booking_status)) {
        return errorResponse(
          res,
          "CONFLICT",
          "이미 완료/취소된 예약은 단가를 변경할 수 없습니다.",
          [],
          409
        );
      }

      const PLATFORM_FEE_RATE = 0.1;
      const platformFee = Math.floor(recommended_price * PLATFORM_FEE_RATE);
      const freelancerAmount = recommended_price - platformFee;

      const updated = await prisma.booking.update({
        where: { id: booking_id },
        data: {
          final_price: recommended_price,
          platform_fee: platformFee,
          freelancer_amount: freelancerAmount,
        },
      });

      // 양측에 단가 변경 안내
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

export default router;
