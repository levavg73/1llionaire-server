/**
 * AI 단가 분석 라우터 (OpenAI GPT Responses API)
 *
 * - POST  /api/ai/pricing-analysis          단위 항목별 단가 분석 리포트 생성
 * - POST  /api/ai/apply-recommendation      관리자: AI 추천 단가를 예약에 반영
 * - PATCH /api/ai/requests/:id/apply-budget 고객/관리자: AI 분석 결과를 요청서 예산에 반영
 * - POST  /api/ai/recommendation-reason     관리자: 특정 프리랜서 추천 사유 생성
 *
 * 이 교체본의 핵심:
 * - OpenAI API 실패 원인을 Render/Vercel 로그에서 바로 볼 수 있게 상세 로그 추가
 * - API Key 값은 절대 로그에 남기지 않고, 존재 여부와 prefix만 확인
 * - OpenAI 응답이 비어 있거나 JSON 파싱 실패 시 별도 로그/응답 처리
 * - 기존 라우트 경로, 권한, 응답 포맷 유지
 */

import { Router, Response, NextFunction } from "express";
import axios from "axios";
import { z } from "zod";
import prisma from "../config/database";
import { env, requireOpenAIKey } from "../config/env";
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

interface OpenAIResponseContentPart {
  type?: string;
  text?: string;
}

interface OpenAIResponseOutputItem {
  type?: string;
  content?: OpenAIResponseContentPart[];
}

interface OpenAIResponsesApiResponse {
  id?: string;
  output_text?: string;
  output?: OpenAIResponseOutputItem[];
  error?: {
    code?: string;
    message?: string;
    type?: string;
  } | null;
}

class AIServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly clientMessage: string;
  public readonly details: unknown[];

  constructor(opts: {
    code: string;
    message: string;
    clientMessage: string;
    statusCode?: number;
    details?: unknown[];
  }) {
    super(opts.message);
    this.name = "AIServiceError";
    this.code = opts.code;
    this.clientMessage = opts.clientMessage;
    this.statusCode = opts.statusCode ?? 503;
    this.details = opts.details ?? [];
  }
}

const pricingAnalysisResultSchema = z.object({
  event_summary: z.string().min(1).max(300),
  line_items: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        description: z.string().min(1).max(200),
        estimated_price: z.number().int().min(0),
        reason: z.string().min(1).max(300),
      })
    )
    .min(1)
    .max(20),
  recommended_min: z.number().int().min(0),
  recommended_max: z.number().int().min(0),
  recommended_center: z.number().int().min(0),
  confidence: z.enum(["high", "medium", "low"]),
  assumptions: z.array(z.string().min(1).max(300)).default([]),
  caution_notes: z.array(z.string().min(1).max(300)).default([]),
  generated_at: z.string().optional().default(() => new Date().toISOString()),
});

type ParsedPricingAnalysisResult = z.infer<typeof pricingAnalysisResultSchema>;

// ─── OpenAI API 헬퍼 ─────────────────────────────────────────

function getOpenAIKeyDebugInfo(): { hasApiKey: boolean; keyPrefix: string | null } {
  const key = env.OPENAI_API_KEY;

  if (!key) {
    return { hasApiKey: false, keyPrefix: null };
  }

  return {
    hasApiKey: true,
    keyPrefix: key.slice(0, 7), // sk-proj, sk-... 정도만 확인. 전체 키는 절대 출력 금지.
  };
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }

  return String(err);
}

function logOpenAIError(err: unknown, context: string): void {
  if (axios.isAxiosError(err)) {
    console.error(`[OpenAI API Error][${context}]`, {
      status: err.response?.status,
      statusText: err.response?.statusText,
      data: err.response?.data,
      code: err.code,
      message: err.message,
      method: err.config?.method,
      url: err.config?.url,
      timeout: err.config?.timeout,
      model: env.OPENAI_MODEL,
      ...getOpenAIKeyDebugInfo(),
    });
    return;
  }

  console.error(`[OpenAI Non-Axios Error][${context}]`, {
    message: getErrorMessage(err),
    model: env.OPENAI_MODEL,
    ...getOpenAIKeyDebugInfo(),
  });
}

function extractOpenAIText(data: OpenAIResponsesApiResponse): string {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  const textBlocks =
    data.output
      ?.flatMap((item) =>
        (item.content ?? []).flatMap((part) => {
          if (part.type === "output_text" && typeof part.text === "string" && part.text.trim()) {
            return [part.text];
          }

          return [];
        })
      )
      .join("\n") ?? "";

  return textBlocks;
}

async function callGPT(prompt: string, systemPrompt: string, context: string): Promise<string> {
  let apiKey: string;

  try {
    apiKey = requireOpenAIKey();
  } catch (err) {
    console.error(`[AI Config Error][${context}]`, {
      message: getErrorMessage(err),
      model: env.OPENAI_MODEL,
      ...getOpenAIKeyDebugInfo(),
    });

    throw new AIServiceError({
      code: "AI_CONFIG_ERROR",
      message: "OPENAI_API_KEY is missing.",
      clientMessage: "AI 분석 서비스 설정이 누락되었습니다. 관리자에게 문의해 주세요.",
      statusCode: 503,
    });
  }

  try {
    const response = await axios.post<OpenAIResponsesApiResponse>(
      "https://api.openai.com/v1/responses",
      {
        model: env.OPENAI_MODEL,
        instructions: systemPrompt,
        input: prompt,
        max_output_tokens: 1500,
        store: false,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30_000,
      }
    );

    if (response.data.error) {
      console.error(`[OpenAI Response Error][${context}]`, {
        error: response.data.error,
        responseId: response.data.id,
        model: env.OPENAI_MODEL,
        ...getOpenAIKeyDebugInfo(),
      });

      throw new AIServiceError({
        code: "AI_RESPONSE_ERROR",
        message: response.data.error.message ?? "OpenAI response contained an error.",
        clientMessage: "AI 분석 서비스에 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
        statusCode: 503,
      });
    }

    const text = extractOpenAIText(response.data).trim();

    if (!text) {
      console.error(`[OpenAI Empty Response][${context}]`, {
        responseId: response.data.id,
        dataKeys: Object.keys(response.data),
        model: env.OPENAI_MODEL,
        ...getOpenAIKeyDebugInfo(),
      });

      throw new AIServiceError({
        code: "AI_EMPTY_RESPONSE",
        message: "OpenAI returned an empty text response.",
        clientMessage: "AI 분석 결과가 비어 있습니다. 다시 시도해 주세요.",
        statusCode: 503,
      });
    }

    return text;
  } catch (err) {
    if (err instanceof AIServiceError) {
      throw err;
    }

    if (axios.isAxiosError(err)) {
      logOpenAIError(err, context);

      const upstreamStatus = err.response?.status;
      const clientMessage =
        upstreamStatus === 401 || upstreamStatus === 403
          ? "AI 분석 서비스 인증 설정에 문제가 있습니다. 관리자에게 문의해 주세요."
          : upstreamStatus === 429
            ? "AI 분석 요청이 일시적으로 많거나 사용량 한도에 도달했습니다. 잠시 후 다시 시도해 주세요."
            : "AI 분석 서비스에 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";

      throw new AIServiceError({
        code: "AI_UPSTREAM_ERROR",
        message: err.message,
        clientMessage,
        statusCode: 503,
      });
    }

    logOpenAIError(err, context);

    throw new AIServiceError({
      code: "AI_UNKNOWN_ERROR",
      message: getErrorMessage(err),
      clientMessage: "AI 분석 서비스에 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
      statusCode: 503,
    });
  }
}

function extractJsonString(raw: string): string {
  const fencedJsonMatch = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fencedJsonMatch?.[1]) {
    return fencedJsonMatch[1].trim();
  }

  const fencedMatch = raw.match(/```\s*([\s\S]*?)```/);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1).trim();
  }

  return raw.trim();
}

function normalizePricingAnalysis(
  parsed: ParsedPricingAnalysisResult
): PricingAnalysisResult {
  const min = parsed.recommended_min;
  const max = Math.max(parsed.recommended_max, min);
  const center = Math.min(Math.max(parsed.recommended_center, min), max);

  return {
    event_summary: parsed.event_summary,
    line_items: parsed.line_items,
    recommended_min: min,
    recommended_max: max,
    recommended_center: center,
    confidence: parsed.confidence,
    assumptions: parsed.assumptions,
    caution_notes: parsed.caution_notes,
    generated_at: new Date().toISOString(),
  };
}

function parsePricingJson(raw: string): PricingAnalysisResult {
  try {
    const jsonStr = extractJsonString(raw);
    const parsed = JSON.parse(jsonStr) as unknown;
    const validated = pricingAnalysisResultSchema.parse(parsed);

    return normalizePricingAnalysis(validated);
  } catch (err) {
    console.error("[AI Pricing JSON Parse Error]", {
      message: getErrorMessage(err),
      rawPreview: raw.slice(0, 1500),
    });

    throw new AIServiceError({
      code: "AI_PARSE_ERROR",
      message: "AI pricing response was not valid JSON.",
      clientMessage: "AI 분석 결과 형식이 올바르지 않습니다. 다시 시도해 주세요.",
      statusCode: 503,
    });
  }
}

function handleAIServiceError(err: unknown, res: Response): boolean {
  if (!(err instanceof AIServiceError)) {
    return false;
  }

  return Boolean(
    errorResponse(res, err.code, err.clientMessage, err.details, err.statusCode)
  );
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
제공된 시장 데이터와 요청 조건을 바탕으로 단위 항목별 적정 단가를 분석합니다.

반드시 JSON 객체 하나만 응답하세요. 마크다운 코드블록, 설명 문장, 주석은 절대 포함하지 마세요.

응답 JSON 형식:
{
  "event_summary": "행사 조건 요약, 100자 이내",
  "line_items": [
    {
      "name": "항목명, 예: 사전 미팅",
      "description": "항목 설명, 50자 이내",
      "estimated_price": 100000,
      "reason": "산정 근거, 80자 이내"
    }
  ],
  "recommended_min": 100000,
  "recommended_max": 200000,
  "recommended_center": 150000,
  "confidence": "high",
  "assumptions": ["가정 1", "가정 2"],
  "caution_notes": ["주의사항 1", "주의사항 2"],
  "generated_at": "ISO 8601 현재 시각"
}

제약:
- confidence는 반드시 high, medium, low 중 하나입니다.
- 모든 금액은 원 단위 정수입니다.
- recommended_min <= recommended_center <= recommended_max 관계를 지키세요.
- line_items는 행사에 필요한 항목만 포함하세요.

VOIT 기준 단위 항목 예시:
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
- 고객 예산: ${
        body.budget_min !== undefined
          ? `${body.budget_min.toLocaleString("ko-KR")}원`
          : "미설정"
      } ~ ${
        body.budget_max !== undefined
          ? `${body.budget_max.toLocaleString("ko-KR")}원`
          : "미설정"
      }
- 진행 시간: ${body.duration_hours ?? "미정"}시간

## 플랫폼 시장 데이터 (${marketData.sample_count}명 기준)
- 평균 최소 단가: ${marketData.avg_price_min.toLocaleString("ko-KR")}원
- 평균 최대 단가: ${marketData.avg_price_max.toLocaleString("ko-KR")}원
- 시장 최저가: ${marketData.market_min.toLocaleString("ko-KR")}원
- 시장 최고가: ${marketData.market_max.toLocaleString("ko-KR")}원
- 평균 평점: ${marketData.avg_rating}점

위 조건으로 단위 항목별 단가를 분석해 주세요.`;

      const rawResponse = await callGPT(prompt, systemPrompt, "pricing-analysis");
      const analysis = parsePricingJson(rawResponse);

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
      if (handleAIServiceError(err, res)) {
        return;
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

      await Promise.all([
        createNotification(prisma, {
          user_id: booking.customer_id,
          type: "booking_price_updated",
          title: "예약 단가 조정 안내",
          message: `"${booking.event_title}" 예약 단가가 AI 분석 기반으로 ${recommended_price.toLocaleString("ko-KR")}원으로 조정되었습니다.`,
          link_url: "/customer/bookings",
        }),
        createNotification(prisma, {
          user_id: booking.freelancer.user_id,
          type: "booking_price_updated",
          title: "예약 단가 조정 안내",
          message: `"${booking.event_title}" 예약 단가가 ${recommended_price.toLocaleString("ko-KR")}원으로 조정되었습니다. (정산액: ${freelancerAmount.toLocaleString("ko-KR")}원)`,
          link_url: "/freelancer/bookings",
        }),
      ]);

      return successResponse(res, updated, "AI 추천 단가가 반영되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// ─── PATCH /api/ai/requests/:id/apply-budget ─────────────────
// 고객/관리자: AI 분석 결과를 요청서 예산에 반영

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
        select: {
          id: true,
          customer_id: true,
          event_title: true,
          status: true,
        },
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
        data: {
          budget_min: body.budget_min,
          budget_max: body.budget_max,
        },
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
            event_title: true,
            event_type: true,
            region: true,
            budget_min: true,
            budget_max: true,
            preferred_freelancer_type: true,
            preferred_styles: true,
          },
        }),
        prisma.freelancerProfile.findUnique({
          where: { id: freelancer_id },
          select: {
            display_name: true,
            categories: true,
            styles: true,
            career_years: true,
            region: true,
            avg_rating: true,
            review_count: true,
            base_price_min: true,
            base_price_max: true,
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
- 단가: ${freelancer.base_price_min?.toLocaleString("ko-KR") ?? "미설정"}원 ~ ${freelancer.base_price_max?.toLocaleString("ko-KR") ?? "미설정"}원
- 한줄 소개: ${freelancer.headline ?? "없음"}

이 진행자를 이 요청서에 추천하는 구체적인 사유를 2~3문장으로 작성해 주세요.`;

      const reason = await callGPT(prompt, systemPrompt, "recommendation-reason");

      return successResponse(res, { reason: reason.trim() });
    } catch (err) {
      if (handleAIServiceError(err, res)) {
        return;
      }

      next(err);
    }
  }
);

export default router;
