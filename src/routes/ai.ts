/**
 * AI 단가 분석 라우터 (Google Gemini generateContent API)
 *
 * - POST /api/ai/pricing-analysis     — 단위 항목별 단가 분석 리포트 생성
 * - POST /api/ai/apply-recommendation — 관리자: AI 추천 단가를 예약에 반영
 * - PATCH /api/customer/requests/:id/apply-ai-budget — 고객 요청서 예산 반영
 *
 * SRP: AI 연동 로직만 담당
 * DIP: requireGeminiKey()로 키 검증 분리
 */

import { Router, Response, NextFunction } from "express";
import axios from "axios";
import { z } from "zod";
import prisma from "../config/database";
import { env, requireGeminiKey } from "../config/env";
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

export type BudgetRealismStatus = "below_market" | "within_market" | "above_market" | "unknown";

export interface PricingAnalysisResult {
  event_summary: string;
  line_items: LineItem[];
  recommended_min: number;
  recommended_max: number;
  recommended_center: number;
  confidence: Confidence;
  budget_realism: {
    status: BudgetRealismStatus;
    message: string;
    recommended_action: string;
  };
  assumptions: string[];
  caution_notes: string[];
  generated_at: string;
}

interface GeminiResponsePart {
  text?: string;
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiResponsePart[];
    role?: string;
  };
  finishReason?: string;
}

interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: {
    blockReason?: string;
  };
  error?: {
    code?: number;
    message?: string;
    status?: string;
  } | null;
}

interface GeminiCallOptions {
  maxOutputTokens?: number;
  responseMimeType?: "application/json" | "text/plain";
}

type GeminiErrorDetail = {
  message: string;
  status?: number;
  statusText?: string;
  code?: string;
  providerStatus?: string;
  providerMessage?: string;
  providerCode?: number;
  url?: string;
  timeout?: number;
};

function getGeminiErrorDetail(error: unknown): GeminiErrorDetail {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as
      | { error?: { code?: number; message?: string; status?: string } }
      | undefined;

    return {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      code: error.code,
      providerStatus: data?.error?.status,
      providerMessage: data?.error?.message,
      providerCode: data?.error?.code,
      url: error.config?.url,
      timeout: error.config?.timeout,
    };
  }

  return {
    message: error instanceof Error ? error.message : String(error),
  };
}

function logGeminiError(label: string, error: unknown, meta: Record<string, unknown> = {}) {
  console.error(label, {
    ...meta,
    gemini_error: getGeminiErrorDetail(error),
  });
}

// ─── Gemini API 헬퍼 ─────────────────────────────────────────

async function callGemini(
  prompt: string,
  systemPrompt: string,
  options: GeminiCallOptions = {}
): Promise<string> {
  const apiKey = requireGeminiKey();
  const modelPath = env.GEMINI_MODEL.startsWith("models/")
    ? env.GEMINI_MODEL
    : `models/${env.GEMINI_MODEL}`;

  const response = await axios.post<GeminiGenerateContentResponse>(
    `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent`,
    {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      generationConfig: {
        maxOutputTokens: options.maxOutputTokens ?? 1500,
        ...(options.responseMimeType
          ? { responseMimeType: options.responseMimeType }
          : {}),
      },
    },
    {
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      timeout: 30_000,
    }
  );

  if (response.data.error) {
    throw new Error(response.data.error.message ?? "Gemini API error");
  }

  if (response.data.promptFeedback?.blockReason) {
    throw new Error(
      `Gemini API blocked the prompt: ${response.data.promptFeedback.blockReason}`
    );
  }

  const textBlocks =
    response.data.candidates
      ?.flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text)
      .filter((text): text is string => typeof text === "string")
      .join("\n")
      .trim() ?? "";

  if (!textBlocks) {
    throw new Error("Gemini API returned an empty response");
  }

  return textBlocks;
}

function parsePricingJson(raw: string): PricingAnalysisResult {
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) ?? raw.match(/({[\s\S]*})/);
  const jsonStr = jsonMatch ? jsonMatch[1] : raw;
  return JSON.parse(jsonStr.trim()) as PricingAnalysisResult;
}

// ─── GET /api/ai/health ─────────────────────────────────────
// 관리자: Gemini 키/모델/응답 형식만 분리해서 진단합니다.

router.get(
  "/health",
  requireAdmin,
  async (_req: AuthRequest, res: Response) => {
    try {
      const raw = await callGemini(
        "{\"ok\":true,\"service\":\"gemini\"} JSON만 반환하세요.",
        "반드시 JSON 객체만 반환하세요. 마크다운과 설명문은 금지입니다.",
        { maxOutputTokens: 64, responseMimeType: "application/json" }
      );
      const parsed = JSON.parse((raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw).trim()) as Record<string, unknown>;

      return successResponse(res, {
        configured: Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY),
        model: env.GEMINI_MODEL,
        ok: true,
        provider_response: parsed,
      });
    } catch (error) {
      const detail = getGeminiErrorDetail(error);
      console.error("[gemini-health-check-failed]", { gemini_error: detail });

      return errorResponse(
        res,
        "GEMINI_HEALTH_CHECK_FAILED",
        "Gemini 연결 확인에 실패했습니다. 서버 환경변수와 API 키 권한을 확인해 주세요.",
        [
          {
            configured: Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY),
            model: env.GEMINI_MODEL,
            gemini_error: detail,
          },
        ],
        503
      );
    }
  }
);

// ─── POST /api/ai/pricing-analysis ───────────────────────────

const pricingSchema = z.object({
  event_type: z.string().min(1).max(100),
  region: z.string().min(1).max(100),
  categories: z.array(z.string()).min(1).max(10),
  career_years_min: z.number().int().min(0).optional(),
  budget_min: z.number().int().min(0).optional(),
  budget_max: z.number().int().min(0).optional(),
  duration_hours: z.number().min(0.5).max(24).optional(),
  event_date: z.string().max(30).optional(),
  start_time: z.string().max(10).optional(),
  end_time: z.string().max(10).optional(),
  venue: z.string().max(200).optional(),
  description: z.string().max(3000).optional(),
  preferred_styles: z.array(z.string()).max(20).optional(),
  required_language: z.string().max(50).optional(),
  script_required: z.boolean().optional(),
  rehearsal_required: z.boolean().optional(),
  travel_required: z.boolean().optional(),
  request_id: z.string().optional(),
});

type PricingRequestBody = z.infer<typeof pricingSchema>;

type PricingMarketData = {
  sample_count: number;
  avg_price_min: number;
  avg_price_max: number;
  market_min: number;
  market_max: number;
  avg_rating: string;
};

function roundToTenThousand(value: number) {
  return Math.max(0, Math.round(value / 10_000) * 10_000);
}

function buildBudgetRealism(
  body: PricingRequestBody,
  marketData: PricingMarketData,
  recommendedMin: number,
  recommendedMax: number,
  recommendedCenter: number
): PricingAnalysisResult["budget_realism"] {
  const hasBudget = Boolean(body.budget_min || body.budget_max);
  if (!hasBudget) {
    return {
      status: "unknown",
      message: "고객 예산이 입력되지 않아 시장 단가 기준으로 적정 범위를 산정했습니다.",
      recommended_action: "추천 범위를 기준으로 예산을 설정한 뒤 후보와 세부 조건을 조율하세요.",
    };
  }

  const budgetMin = body.budget_min ?? 0;
  const budgetMax = body.budget_max ?? body.budget_min ?? 0;
  const marketCenter = marketData.avg_price_min || marketData.avg_price_max
    ? Math.round(((marketData.avg_price_min || marketData.market_min || recommendedCenter) + (marketData.avg_price_max || marketData.market_max || recommendedCenter)) / 2)
    : recommendedCenter;

  if (budgetMax > 0 && budgetMax < recommendedMin) {
    return {
      status: "below_market",
      message: `입력 예산 상한 ${budgetMax.toLocaleString("ko-KR")}원은 산정된 적정 최소 단가 ${recommendedMin.toLocaleString("ko-KR")}원보다 낮습니다.`,
      recommended_action: "예산을 상향하거나 행사 시간, 대본/리허설, 출장 범위를 줄여 조건을 조정하는 편이 현실적입니다.",
    };
  }

  if (budgetMin > 0 && budgetMin > Math.round(recommendedMax * 1.25)) {
    return {
      status: "above_market",
      message: `입력 예산은 유사 시장 단가 중심값 ${marketCenter.toLocaleString("ko-KR")}원보다 여유가 있습니다.`,
      recommended_action: "상위 경력자, 외국어 진행, 대본 작성, 리허설 포함 조건으로 후보 품질을 높일 수 있습니다.",
    };
  }

  return {
    status: "within_market",
    message: "입력 예산은 플랫폼 시장 데이터와 행사 조건을 기준으로 현실적인 범위에 있습니다.",
    recommended_action: "현재 예산 범위 안에서 경력, 후기, 포트폴리오가 맞는 후보를 우선 비교하세요.",
  };
}

function normalizePricingAnalysis(
  analysis: PricingAnalysisResult,
  body: PricingRequestBody,
  marketData: PricingMarketData
): PricingAnalysisResult {
  const fallback = buildFallbackPricingAnalysis(body, marketData);
  const recommendedCenter = roundToTenThousand(Number(analysis.recommended_center) || fallback.recommended_center);
  const recommendedMin = roundToTenThousand(Number(analysis.recommended_min) || fallback.recommended_min || recommendedCenter);
  const recommendedMax = roundToTenThousand(Math.max(Number(analysis.recommended_max) || fallback.recommended_max || recommendedCenter, recommendedMin));

  return {
    ...analysis,
    line_items: Array.isArray(analysis.line_items) ? analysis.line_items : [],
    recommended_min: recommendedMin,
    recommended_max: recommendedMax,
    recommended_center: recommendedCenter,
    confidence: ["high", "medium", "low"].includes(analysis.confidence) ? analysis.confidence : "medium",
    budget_realism: analysis.budget_realism?.message
      ? analysis.budget_realism
      : buildBudgetRealism(body, marketData, recommendedMin, recommendedMax, recommendedCenter),
    assumptions: Array.isArray(analysis.assumptions) ? analysis.assumptions : [],
    caution_notes: Array.isArray(analysis.caution_notes) ? analysis.caution_notes : [],
    generated_at: new Date().toISOString(),
  };
}

function buildFallbackPricingAnalysis(
  body: PricingRequestBody,
  marketData: PricingMarketData
): PricingAnalysisResult {
  const marketMinBasis = marketData.avg_price_min || marketData.market_min || 0;
  const marketMaxBasis = marketData.avg_price_max || marketData.market_max || marketMinBasis;
  const marketAverage = marketMinBasis
    ? Math.round((marketMinBasis + marketMaxBasis) / 2)
    : 0;
  const budgetAverage = body.budget_min && body.budget_max
    ? Math.round((body.budget_min + body.budget_max) / 2)
    : body.budget_max ?? body.budget_min ?? 0;
  const baseCenter = marketAverage || budgetAverage || 500_000;
  const durationHours = body.duration_hours ?? 2;
  const durationMultiplier = 1 + Math.max(0, durationHours - 2) * 0.15;
  const recommendedCenter = roundToTenThousand(baseCenter * durationMultiplier);
  const recommendedMin = roundToTenThousand(
    Math.max(recommendedCenter * 0.85, body.budget_min ?? 0)
  );
  const recommendedMaxBaseline = recommendedCenter * 1.15;
  const recommendedMax = roundToTenThousand(
    Math.max(recommendedMin, recommendedMaxBaseline)
  );

  const lineItems: LineItem[] = [
    {
      name: "본행사 진행",
      description: `${durationHours}시간 기준 핵심 진행 비용`,
      estimated_price: roundToTenThousand(recommendedCenter * 0.62),
      reason: "유사 진행자 평균 단가와 행사 시간을 반영",
    },
    {
      name: "사전 미팅/큐시트 확인",
      description: "행사 흐름 및 진행 톤 사전 조율",
      estimated_price: roundToTenThousand(recommendedCenter * 0.12),
      reason: "행사 완성도 확보를 위한 기본 준비 비용",
    },
    ...(body.script_required
      ? [
          {
            name: "대본 검토/작성",
            description: "행사 대본과 큐시트 사전 준비",
            estimated_price: roundToTenThousand(recommendedCenter * 0.1),
            reason: "대본 작성 또는 검토 요청 조건 반영",
          },
        ]
      : []),
    ...(body.rehearsal_required
      ? [
          {
            name: "리허설 참석",
            description: "현장 또는 온라인 리허설 참여",
            estimated_price: roundToTenThousand(recommendedCenter * 0.08),
            reason: "리허설 필요 조건 반영",
          },
        ]
      : []),
    ...(body.travel_required
      ? [
          {
            name: "출장/이동 대응",
            description: "지역 이동 및 현장 도착 리스크",
            estimated_price: roundToTenThousand(recommendedCenter * 0.06),
            reason: "출장 필요 조건 반영",
          },
        ]
      : []),
    {
      name: "현장 변수 대응",
      description: "현장 상황 대응 및 진행 보정",
      estimated_price: roundToTenThousand(recommendedCenter * 0.12),
      reason: "현장형 진행 업무의 리스크 비용 반영",
    },
  ];

  return {
    event_summary: `${body.region} ${body.event_type} / ${body.categories.join(", ")}${body.description ? ` / ${body.description}` : ""}`.slice(0, 100),
    line_items: lineItems,
    recommended_min: recommendedMin,
    recommended_max: recommendedMax,
    recommended_center: recommendedCenter,
    confidence: marketData.sample_count >= 5 ? "medium" : "low",
    budget_realism: buildBudgetRealism(body, marketData, recommendedMin, recommendedMax, recommendedCenter),
    assumptions: [
      "플랫폼 내 승인 진행자 단가 데이터를 우선 반영했습니다.",
      "AI 외부 모델 응답이 불안정할 때 시장 데이터 기반 산식으로 계산했습니다.",
    ],
    caution_notes: [
      "외부 AI 분석 서비스 장애 또는 키 설정 문제로 자동 보정 결과가 사용되었습니다.",
      "정확한 견적은 대본 작성, 리허설, 출장 범위 확정 후 달라질 수 있습니다.",
    ],
    generated_at: new Date().toISOString(),
  };
}

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
고객 예산에 억지로 맞추지 말고, 행사 시간·요구 경력·지역·분야·플랫폼 시장 단가 기준으로 예산이 현실적인지 판단합니다.

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
  "budget_realism": {
    "status": "<below_market|within_market|above_market|unknown>",
    "message": "<고객 예산이 시장/시간/경력 조건상 현실적인지 판단>",
    "recommended_action": "<예산 상향, 조건 조정, 상위 후보 가능성 등 다음 행동>"
  },
  "assumptions": ["<가정 1>", "<가정 2>"],
  "caution_notes": ["<주의사항 1>", "<주의사항 2>"],
  "generated_at": "<ISO 8601 현재 시각>"
}

VOIT 기준 단위 항목 예시 (해당 조건에 맞게 선택):
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
- 행사 날짜/시간: ${body.event_date ?? "미정"} ${body.start_time ?? ""}~${body.end_time ?? ""}
- 상세 장소: ${body.venue || "미정"}
- 선호 스타일: ${body.preferred_styles?.join(", ") || "미정"}
- 필요 언어: ${body.required_language || "한국어"}
- 대본 작성 필요: ${body.script_required ? "예" : "아니오"}
- 리허설 필요: ${body.rehearsal_required ? "예" : "아니오"}
- 출장 필요: ${body.travel_required ? "예" : "아니오"}
- 요청사항: ${body.description || "없음"}

## 플랫폼 시장 데이터 (${marketData.sample_count}명 기준)
- 평균 최소 단가: ${marketData.avg_price_min.toLocaleString("ko-KR")}원
- 평균 최대 단가: ${marketData.avg_price_max.toLocaleString("ko-KR")}원
- 시장 최저가: ${marketData.market_min.toLocaleString("ko-KR")}원
- 시장 최고가: ${marketData.market_max.toLocaleString("ko-KR")}원
- 평균 평점: ${marketData.avg_rating}점

위 조건으로 단위 항목별 단가를 분석해 주세요. line_items는 해당 행사에 필요한 항목만 포함하세요.
고객 예산이 시장가보다 낮으면 추천 단가를 억지로 낮추지 말고 budget_realism.status를 below_market으로 표시하고 이유를 설명하세요.
진행 시간이 길거나 최소 경력이 높으면 본행사 진행비와 준비비를 현실적으로 상향 반영하세요.`;

      let analysisSource: "gemini" | "market_fallback" = "gemini";
      let analysis: PricingAnalysisResult;
      let geminiError: GeminiErrorDetail | null = null;

      try {
        const rawResponse = await callGemini(prompt, systemPrompt, { responseMimeType: "application/json" });
        analysis = parsePricingJson(rawResponse);
      } catch (aiError) {
        analysisSource = "market_fallback";
        geminiError = getGeminiErrorDetail(aiError);
        logGeminiError("[ai-pricing-analysis-fallback]", aiError, { request_id: body.request_id });
        analysis = buildFallbackPricingAnalysis(body, marketData);
      }

      analysis = normalizePricingAnalysis(analysis, body, marketData);

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
        market_data: { ...marketData, analysis_source: analysisSource },
        diagnostic: geminiError
          ? {
              analysis_source: analysisSource,
              gemini_status: geminiError.status,
              gemini_provider_status: geminiError.providerStatus,
              gemini_error_message: geminiError.providerMessage ?? geminiError.message,
            }
          : { analysis_source: analysisSource },
      });
    } catch (err) {
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

      const reason = await callGemini(prompt, systemPrompt);

      return successResponse(res, { reason: reason.trim() });
    } catch (err) {
      if (axios.isAxiosError(err) && err.config?.url?.includes("generativelanguage")) {
        const detail = getGeminiErrorDetail(err);
        console.error("[ai-recommendation-reason-failed]", { gemini_error: detail });
        return errorResponse(
          res,
          "GEMINI_REQUEST_FAILED",
          "AI 서비스 오류가 발생했습니다. Gemini 연결 상태를 확인해 주세요.",
          [detail],
          503
        );
      }
      next(err);
    }
  }
);

export default router;