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

export type BudgetRealismStatus =
  | "below_market"
  | "within_market"
  | "above_market"
  | "unknown";

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
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  // gemini-2.5-flash 추론(thinking) 토큰 제어.
  // 0이면 thinking 비활성화 → 정형 작업 응답 속도/지연 대폭 개선.
  thinkingBudget?: number;
  // 호출별 타임아웃(ms). Vercel 함수 시간 예산 분배에 사용.
  timeoutMs?: number;
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

function logGeminiError(
  label: string,
  error: unknown,
  meta: Record<string, unknown> = {},
) {
  console.error(label, {
    ...meta,
    gemini_error: getGeminiErrorDetail(error),
  });
}

// ─── Gemini API 헬퍼 ─────────────────────────────────────────

async function callGemini(
  prompt: string,
  systemPrompt: string,
  options: GeminiCallOptions = {},
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
        temperature: options.temperature ?? 0.25,
        ...(options.thinkingBudget !== undefined
          ? { thinkingConfig: { thinkingBudget: options.thinkingBudget } }
          : {}),
        ...(options.responseMimeType
          ? { responseMimeType: options.responseMimeType }
          : {}),
        ...(options.responseSchema
          ? { responseSchema: options.responseSchema }
          : {}),
      },
    },
    {
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      // Vercel 함수 한도(Hobby 10s)보다 짧게 잡아 코드가 먼저 에러를 잡도록 함.
      // 504 강제종료 대신 깔끔한 에러 메시지를 화면에 표시할 수 있음.
      timeout: options.timeoutMs ?? 9_000,
    },
  );

  if (response.data.error) {
    throw new Error(response.data.error.message ?? "Gemini API error");
  }

  if (response.data.promptFeedback?.blockReason) {
    throw new Error(
      `Gemini API blocked the prompt: ${response.data.promptFeedback.blockReason}`,
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

function stripJsonCodeFence(raw: string) {
  return raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function extractJsonObject(raw: string) {
  const cleaned = stripJsonCodeFence(raw);
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");

  if (first === -1 || last === -1 || last <= first) {
    throw new Error("Gemini response does not contain a JSON object");
  }

  return cleaned.slice(first, last + 1).trim();
}

function removeTrailingCommas(json: string) {
  return json.replace(/,\s*([}\]])/g, "$1");
}

function quoteUnquotedObjectKeys(json: string) {
  return json.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
}

function parseJsonObject<T>(raw: string): T {
  const extracted = extractJsonObject(raw);
  const candidates = [
    extracted,
    removeTrailingCommas(extracted),
    quoteUnquotedObjectKeys(removeTrailingCommas(extracted)),
  ];

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to parse Gemini JSON response");
}

function parsePricingJson(raw: string): PricingAnalysisResult {
  return parseJsonObject<PricingAnalysisResult>(raw);
}

// ─── GET /api/ai/health ─────────────────────────────────────
// 관리자: Gemini 키/모델/응답 형식만 분리해서 진단합니다.

router.get(
  "/health",
  requireAdmin,
  async (_req: AuthRequest, res: Response) => {
    try {
      const raw = await callGemini(
        '{"ok":true,"service":"gemini"} JSON만 반환하세요.',
        "반드시 JSON 객체만 반환하세요. 마크다운과 설명문은 금지입니다.",
        {
          maxOutputTokens: 64,
          responseMimeType: "application/json",
          thinkingBudget: 0,
        },
      );
      const parsed = parseJsonObject<Record<string, unknown>>(raw);

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
        503,
      );
    }
  },
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
  median_price_min: number;
  median_price_max: number;
  avg_rating: string;
};

type PricingSimilarFreelancer = {
  display_name: string | null;
  categories: string[];
  career_years: number | null;
  base_price_min: number | null;
  base_price_max: number | null;
  languages: string[];
  script_writing_available: boolean;
  rehearsal_available: boolean;
  travel_available: boolean;
  avg_rating: number | null;
  review_count: number;
};

type PricingGuide = {
  role: string;
  career_tier: string;
  core_base_price: number;
  duration_multiplier: number;
  career_multiplier: number;
  language_surcharge_rate: number;
  language_surcharge_center: number;
  script_fee_range: [number, number];
  rehearsal_fee_range: [number, number];
  travel_fee_range: [number, number];
  guide_min: number;
  guide_center: number;
  guide_max: number;
  notes: string[];
};

const pricingAnalysisResponseSchema = {
  type: "object",
  properties: {
    event_summary: { type: "string" },
    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          estimated_price: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["name", "description", "estimated_price", "reason"],
      },
    },
    recommended_min: { type: "integer" },
    recommended_max: { type: "integer" },
    recommended_center: { type: "integer" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    budget_realism: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["below_market", "within_market", "above_market", "unknown"],
        },
        message: { type: "string" },
        recommended_action: { type: "string" },
      },
      required: ["status", "message", "recommended_action"],
    },
    assumptions: { type: "array", items: { type: "string" } },
    caution_notes: { type: "array", items: { type: "string" } },
    generated_at: { type: "string" },
  },
  required: [
    "event_summary",
    "line_items",
    "recommended_min",
    "recommended_max",
    "recommended_center",
    "confidence",
    "budget_realism",
    "assumptions",
    "caution_notes",
    "generated_at",
  ],
} satisfies Record<string, unknown>;

function roundToTenThousand(value: number) {
  return Math.max(0, Math.round(value / 10_000) * 10_000);
}

function median(values: number[]) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

function includesEnglish(language?: string | null) {
  if (!language) return false;
  return /영어|english|en\b/i.test(language);
}

function includesNonKoreanLanguage(language?: string | null) {
  if (!language) return false;
  const normalized = language.toLowerCase();
  if (/한국어|korean|ko\b/.test(normalized) && !includesEnglish(language)) {
    return false;
  }
  return /영어|english|중국어|chinese|일본어|japanese|스페인어|spanish|프랑스어|french|독일어|german|베트남어|vietnamese|태국어|thai/i.test(language);
}

function getPrimaryRole(categories: string[]) {
  if (categories.some((category) => category.includes("아나운서"))) return "아나운서";
  if (categories.some((category) => category.includes("컨퍼런스"))) return "컨퍼런스 MC";
  if (categories.some((category) => category.includes("기업"))) return "기업행사 MC";
  if (categories.some((category) => category.includes("쇼호스트"))) return "쇼호스트";
  if (categories.some((category) => category.includes("라이브커머스"))) return "라이브커머스 진행자";
  if (categories.some((category) => category.includes("웨딩"))) return "웨딩 사회자";
  return categories[0] ?? "행사 진행자";
}

function getFallbackCorePrice(categories: string[]) {
  const role = getPrimaryRole(categories);
  if (role.includes("컨퍼런스")) return 700_000;
  if (role.includes("기업") || role.includes("아나운서")) return 600_000;
  if (role.includes("쇼호스트") || role.includes("라이브커머스")) return 500_000;
  if (role.includes("웨딩")) return 350_000;
  return 500_000;
}

function getCareerTier(careerYearsMin = 0) {
  if (careerYearsMin >= 10) return "senior_10_plus";
  if (careerYearsMin >= 5) return "experienced_5_plus";
  if (careerYearsMin >= 3) return "mid_3_plus";
  if (careerYearsMin >= 1) return "junior_1_plus";
  return "entry_available";
}

function getCareerMultiplier(careerYearsMin = 0, sampleCount = 0) {
  // 유사 프리랜서 표본이 충분하면 이미 경력 필터가 반영되어 있으므로 추가 가산을 낮게 잡습니다.
  const dampener = sampleCount >= 5 ? 0.5 : 1;
  if (careerYearsMin >= 10) return 1 + 0.35 * dampener;
  if (careerYearsMin >= 5) return 1 + 0.2 * dampener;
  if (careerYearsMin >= 3) return 1 + 0.1 * dampener;
  if (careerYearsMin >= 1) return 1 + 0.05 * dampener;
  return 1;
}

function getDurationMultiplier(durationHours = 2) {
  if (durationHours <= 2.5) return 1;
  if (durationHours <= 4) return 1.15;
  if (durationHours <= 6) return 1.3;
  return 1.5;
}

function buildPricingGuide(
  body: PricingRequestBody,
  marketData: PricingMarketData,
): PricingGuide {
  const role = getPrimaryRole(body.categories);
  const durationHours = body.duration_hours ?? 2;
  const coreBasis =
    marketData.median_price_min ||
    marketData.avg_price_min ||
    marketData.market_min ||
    getFallbackCorePrice(body.categories);

  const durationMultiplier = getDurationMultiplier(durationHours);
  const careerMultiplier = getCareerMultiplier(
    body.career_years_min ?? 0,
    marketData.sample_count,
  );
  const coreBasePrice = roundToTenThousand(
    coreBasis * durationMultiplier * careerMultiplier,
  );

  const requiredLanguage = body.required_language ?? "한국어";
  const languageSurchargeRate = includesEnglish(requiredLanguage)
    ? 0.25
    : includesNonKoreanLanguage(requiredLanguage)
      ? 0.2
      : 0;
  const languageSurchargeCenter = roundToTenThousand(
    coreBasePrice * languageSurchargeRate,
  );

  const scriptFeeRange: [number, number] = body.script_required
    ? [150_000, 300_000]
    : [0, 0];
  const rehearsalFeeRange: [number, number] = body.rehearsal_required
    ? [100_000, 250_000]
    : [0, 0];
  const isSeoulArea = /서울|경기|인천|수도권/.test(body.region);
  const travelFeeRange: [number, number] = body.travel_required
    ? isSeoulArea
      ? [0, 100_000]
      : [100_000, 300_000]
    : [0, 0];

  const optionMin =
    languageSurchargeCenter * 0.8 +
    scriptFeeRange[0] +
    rehearsalFeeRange[0] +
    travelFeeRange[0];
  const optionCenter =
    languageSurchargeCenter +
    (scriptFeeRange[0] + scriptFeeRange[1]) / 2 +
    (rehearsalFeeRange[0] + rehearsalFeeRange[1]) / 2 +
    (travelFeeRange[0] + travelFeeRange[1]) / 2;
  const optionMax =
    languageSurchargeCenter * 1.2 +
    scriptFeeRange[1] +
    rehearsalFeeRange[1] +
    travelFeeRange[1];

  const marketCeiling = marketData.avg_price_max || marketData.market_max || 0;
  const guideMin = roundToTenThousand(Math.max(coreBasePrice * 0.85 + optionMin, 0));
  const guideCenter = roundToTenThousand(coreBasePrice + optionCenter);
  const guideMaxUncapped = roundToTenThousand(coreBasePrice * 1.15 + optionMax);
  const guideMax = marketCeiling
    ? roundToTenThousand(Math.max(guideCenter, Math.min(guideMaxUncapped, marketCeiling * 1.15)))
    : guideMaxUncapped;

  return {
    role,
    career_tier: getCareerTier(body.career_years_min ?? 0),
    core_base_price: coreBasePrice,
    duration_multiplier: durationMultiplier,
    career_multiplier: careerMultiplier,
    language_surcharge_rate: languageSurchargeRate,
    language_surcharge_center: languageSurchargeCenter,
    script_fee_range: scriptFeeRange,
    rehearsal_fee_range: rehearsalFeeRange,
    travel_fee_range: travelFeeRange,
    guide_min: guideMin,
    guide_center: guideCenter,
    guide_max: guideMax,
    notes: [
      "유사 프리랜서의 최소 기준 단가를 본행사 기준으로 사용하고, 최고가 후보는 상한 참고값으로만 사용합니다.",
      "경력 0년 이상은 신입~초급 후보도 포함하므로 경력 프리미엄을 붙이지 않습니다.",
      "영어 진행, 대본 작성, 리허설, 출장 조건은 별도 항목으로만 가산합니다.",
    ],
  };
}

function buildBudgetRealism(
  body: PricingRequestBody,
  marketData: PricingMarketData,
  recommendedMin: number,
  recommendedMax: number,
  recommendedCenter: number,
): PricingAnalysisResult["budget_realism"] {
  const hasBudget = Boolean(body.budget_min || body.budget_max);
  if (!hasBudget) {
    return {
      status: "unknown",
      message:
        "고객 예산이 입력되지 않아 시장 단가 기준으로 적정 범위를 산정했습니다.",
      recommended_action:
        "추천 범위를 기준으로 예산을 설정한 뒤 후보와 세부 조건을 조율하세요.",
    };
  }

  const budgetMin = body.budget_min ?? 0;
  const budgetMax = body.budget_max ?? body.budget_min ?? 0;
  const marketCenter =
    marketData.avg_price_min || marketData.avg_price_max
      ? Math.round(
          ((marketData.avg_price_min ||
            marketData.market_min ||
            recommendedCenter) +
            (marketData.avg_price_max ||
              marketData.market_max ||
              recommendedCenter)) /
            2,
        )
      : recommendedCenter;

  if (budgetMax > 0 && budgetMax < recommendedMin) {
    return {
      status: "below_market",
      message: `입력 예산 상한 ${budgetMax.toLocaleString("ko-KR")}원은 산정된 적정 최소 단가 ${recommendedMin.toLocaleString("ko-KR")}원보다 낮습니다.`,
      recommended_action:
        "예산을 상향하거나 행사 시간, 대본/리허설, 출장 범위를 줄여 조건을 조정하는 편이 현실적입니다.",
    };
  }

  if (budgetMin > 0 && budgetMin > Math.round(recommendedMax * 1.25)) {
    return {
      status: "above_market",
      message: `입력 예산은 유사 시장 단가 중심값 ${marketCenter.toLocaleString("ko-KR")}원보다 여유가 있습니다.`,
      recommended_action:
        "상위 경력자, 외국어 진행, 대본 작성, 리허설 포함 조건으로 후보 품질을 높일 수 있습니다.",
    };
  }

  return {
    status: "within_market",
    message:
      "입력 예산은 플랫폼 시장 데이터와 행사 조건을 기준으로 현실적인 범위에 있습니다.",
    recommended_action:
      "현재 예산 범위 안에서 경력, 후기, 포트폴리오가 맞는 후보를 우선 비교하세요.",
  };
}

function normalizePricingAnalysis(
  analysis: PricingAnalysisResult,
  body: PricingRequestBody,
  marketData: PricingMarketData,
): PricingAnalysisResult {
  const fallback = buildFallbackPricingAnalysis(body, marketData);
  const recommendedCenter = roundToTenThousand(
    Number(analysis.recommended_center) || fallback.recommended_center,
  );
  const recommendedMin = roundToTenThousand(
    Number(analysis.recommended_min) ||
      fallback.recommended_min ||
      recommendedCenter,
  );
  const recommendedMax = roundToTenThousand(
    Math.max(
      Number(analysis.recommended_max) ||
        fallback.recommended_max ||
        recommendedCenter,
      recommendedMin,
    ),
  );

  return {
    ...analysis,
    line_items: Array.isArray(analysis.line_items) ? analysis.line_items : [],
    recommended_min: recommendedMin,
    recommended_max: recommendedMax,
    recommended_center: recommendedCenter,
    confidence: ["high", "medium", "low"].includes(analysis.confidence)
      ? analysis.confidence
      : "medium",
    budget_realism: analysis.budget_realism?.message
      ? analysis.budget_realism
      : buildBudgetRealism(
          body,
          marketData,
          recommendedMin,
          recommendedMax,
          recommendedCenter,
        ),
    assumptions: Array.isArray(analysis.assumptions)
      ? analysis.assumptions
      : [],
    caution_notes: Array.isArray(analysis.caution_notes)
      ? analysis.caution_notes
      : [],
    generated_at: new Date().toISOString(),
  };
}

function buildFallbackPricingAnalysis(
  body: PricingRequestBody,
  marketData: PricingMarketData,
): PricingAnalysisResult {
  const guide = buildPricingGuide(body, marketData);
  const durationHours = body.duration_hours ?? 2;
  const lineItems: LineItem[] = [
    {
      name: "본행사 진행",
      description: `${durationHours}시간 기준 ${guide.role} 진행`,
      estimated_price: guide.core_base_price,
      reason: "유사 프리랜서 최소 기준 단가와 시간·경력 조건 반영",
    },
    ...(guide.language_surcharge_center > 0
      ? [
          {
            name: includesEnglish(body.required_language) ? "외국어 진행 (영어)" : "외국어 진행",
            description: "외국어 또는 이중언어 진행 가산",
            estimated_price: guide.language_surcharge_center,
            reason: "외국어 진행은 본행사 진행비의 20~25% 범위로 가산",
          },
        ]
      : []),
    ...(body.script_required
      ? [
          {
            name: "대본 작성",
            description: "행사 대본 작성 및 수정",
            estimated_price: roundToTenThousand(
              (guide.script_fee_range[0] + guide.script_fee_range[1]) / 2,
            ),
            reason: "대본 작성 요청 조건 반영",
          },
        ]
      : []),
    ...(body.rehearsal_required
      ? [
          {
            name: "리허설",
            description: "본행사 전 리허설 참여",
            estimated_price: roundToTenThousand(
              (guide.rehearsal_fee_range[0] + guide.rehearsal_fee_range[1]) / 2,
            ),
            reason: "리허설 필요 조건 반영",
          },
        ]
      : []),
    ...(body.travel_required
      ? [
          {
            name: "출장/이동",
            description: "지역 이동 및 현장 도착 리스크",
            estimated_price: roundToTenThousand(
              (guide.travel_fee_range[0] + guide.travel_fee_range[1]) / 2,
            ),
            reason: "출장 필요 조건 반영",
          },
        ]
      : []),
  ];

  const recommendedCenter = roundToTenThousand(
    lineItems.reduce((sum, item) => sum + item.estimated_price, 0) ||
      guide.guide_center,
  );

  return {
    event_summary:
      `${body.region} ${body.event_type} / ${body.categories.join(", ")}${body.description ? ` / ${body.description}` : ""}`.slice(
        0,
        100,
      ),
    line_items: lineItems,
    recommended_min: guide.guide_min,
    recommended_max: Math.max(guide.guide_max, recommendedCenter),
    recommended_center: recommendedCenter,
    confidence: marketData.sample_count >= 5 ? "medium" : "low",
    budget_realism: buildBudgetRealism(
      body,
      marketData,
      guide.guide_min,
      Math.max(guide.guide_max, recommendedCenter),
      recommendedCenter,
    ),
    assumptions: [
      "플랫폼 내 유사 진행자의 최소 기준 단가를 중심값으로 사용했습니다.",
      "고가 후보의 최대 단가는 상한 참고값으로만 반영했습니다.",
    ],
    caution_notes: [
      "정확한 견적은 대본 범위, 리허설 방식, 현장 난이도 확정 후 달라질 수 있습니다.",
      "영어 진행은 후보 숙련도에 따라 편차가 큽니다.",
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

      const pricingProfileWhere = {
        status: "approved" as const,
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
      };

      const [stats, priceSamples, similarFreelancers] = await Promise.all([
        prisma.freelancerProfile.aggregate({
          where: pricingProfileWhere,
          _avg: { base_price_min: true, base_price_max: true, avg_rating: true },
          _min: { base_price_min: true },
          _max: { base_price_max: true },
          _count: true,
        }),
        prisma.freelancerProfile.findMany({
          where: pricingProfileWhere,
          select: { base_price_min: true, base_price_max: true },
          orderBy: [{ base_price_min: "asc" }],
          take: 100,
        }),
        prisma.freelancerProfile.findMany({
          where: pricingProfileWhere,
          select: {
            display_name: true,
            categories: true,
            career_years: true,
            base_price_min: true,
            base_price_max: true,
            languages: true,
            script_writing_available: true,
            rehearsal_available: true,
            travel_available: true,
            avg_rating: true,
            review_count: true,
          },
          orderBy: [{ avg_rating: "desc" }, { review_count: "desc" }],
          take: 8,
        }),
      ]);

      const marketData: PricingMarketData = {
        sample_count: stats._count,
        avg_price_min: Math.round(stats._avg.base_price_min ?? 0),
        avg_price_max: Math.round(stats._avg.base_price_max ?? 0),
        market_min: stats._min.base_price_min ?? 0,
        market_max: stats._max.base_price_max ?? 0,
        median_price_min: median(
          priceSamples
            .map((sample) => sample.base_price_min)
            .filter((value): value is number => typeof value === "number"),
        ),
        median_price_max: median(
          priceSamples
            .map((sample) => sample.base_price_max)
            .filter((value): value is number => typeof value === "number"),
        ),
        avg_rating: stats._avg.avg_rating?.toFixed(1) ?? "N/A",
      };

      const pricingGuide = buildPricingGuide(body, marketData);
      const similarFreelancerSummary = (
        similarFreelancers as PricingSimilarFreelancer[]
      )
        .map((freelancer, index) =>
          `${index + 1}. ${freelancer.display_name ?? "이름 미공개"} / ${freelancer.categories.join(", ") || "분야 미입력"} / 경력 ${freelancer.career_years ?? 0}년 / ${freelancer.base_price_min?.toLocaleString("ko-KR") ?? "미입력"}~${freelancer.base_price_max?.toLocaleString("ko-KR") ?? "미입력"}원 / 언어 ${freelancer.languages.join(", ") || "미입력"}`,
        )
        .join("\n");

      const systemPrompt = `당신은 한국 행사 진행자(MC/아나운서/쇼호스트) 시장 전문 단가 분석가입니다.
제공된 시장 데이터와 요청 조건을 바탕으로 단위 항목별 적정 단가를 분석합니다.
고객 예산에 억지로 맞추지 말고, 행사 시간·요구 경력·지역·분야·플랫폼 시장 단가 기준으로 예산이 현실적인지 판단합니다.
단, 고가 후보의 최대 단가를 추천 중심값으로 사용하지 말고 유사 프리랜서의 최소/중간 기준 단가를 본행사 진행비의 기준으로 삼으세요.
추천 총액은 본행사 진행비 + 외국어 진행 + 대본 작성 + 리허설 + 출장/이동 항목의 합계와 일치해야 합니다.
경력 0년 이상은 신입~초급 후보도 포함한다는 뜻이므로 경력 프리미엄을 붙이지 마세요.

응답은 간결해야 합니다. line_items는 최대 5개, assumptions와 caution_notes는 각각 최대 2개로 제한하세요.
설명문이나 마크다운 없이 아래 JSON 객체만 반환하세요:
{
  "event_summary": "<행사 조건 요약, 80자 이내>",
  "line_items": [
    {
      "name": "<항목명, 예: 사전 미팅>",
      "description": "<항목 설명, 40자 이내>",
      "estimated_price": <예상 금액 (원, 정수)>,
      "reason": "<산정 근거, 50자 이내>"
    }
  ],
  "recommended_min": <최소 추천 총액 (원, 정수)>,
  "recommended_max": <최대 추천 총액 (원, 정수)>,
  "recommended_center": <중심 추천 총액 (원, 정수)>,
  "confidence": "<high|medium|low>",
  "budget_realism": {
    "status": "<below_market|within_market|above_market|unknown>",
    "message": "<예산 현실성 판단, 60자 이내>",
    "recommended_action": "<다음 행동, 60자 이내>"
  },
  "assumptions": ["<가정, 40자 이내>"],
  "caution_notes": ["<주의사항, 40자 이내>"],
  "generated_at": "<ISO 8601 현재 시각>"
}

단위 항목 예시 (해당 조건에 맞는 것만 선택): 본행사 진행(핵심 비용), 외국어 진행(영어 +20~30%·기타 +20%), 대본 작성(15~30만), 리허설(10~25만), 출장/이동(지역별), 라이브커머스 상품 숙지(10~30만).
사전 미팅/현장 변수 대응은 별도 유료 조건이 명확하지 않으면 독립 항목으로 추가하지 마세요.`;

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
- 중앙 최소 단가: ${marketData.median_price_min.toLocaleString("ko-KR")}원
- 중앙 최대 단가: ${marketData.median_price_max.toLocaleString("ko-KR")}원
- 시장 최저가: ${marketData.market_min.toLocaleString("ko-KR")}원
- 시장 최고가: ${marketData.market_max.toLocaleString("ko-KR")}원
- 평균 평점: ${marketData.avg_rating}점

## 유사 프리랜서 표본
${similarFreelancerSummary || "유사 표본 없음"}

## 추천 산식 가이드
- 기준 역할: ${pricingGuide.role}
- 경력 구간: ${pricingGuide.career_tier}
- 본행사 기준 진행비: ${pricingGuide.core_base_price.toLocaleString("ko-KR")}원
- 시간 가중치: ${pricingGuide.duration_multiplier}
- 경력 가중치: ${pricingGuide.career_multiplier}
- 외국어 가산율: ${Math.round(pricingGuide.language_surcharge_rate * 100)}%
- 외국어 가산 중심값: ${pricingGuide.language_surcharge_center.toLocaleString("ko-KR")}원
- 대본 작성 범위: ${pricingGuide.script_fee_range[0].toLocaleString("ko-KR")}~${pricingGuide.script_fee_range[1].toLocaleString("ko-KR")}원
- 리허설 범위: ${pricingGuide.rehearsal_fee_range[0].toLocaleString("ko-KR")}~${pricingGuide.rehearsal_fee_range[1].toLocaleString("ko-KR")}원
- 출장/이동 범위: ${pricingGuide.travel_fee_range[0].toLocaleString("ko-KR")}~${pricingGuide.travel_fee_range[1].toLocaleString("ko-KR")}원
- 권장 총액 가이드: ${pricingGuide.guide_min.toLocaleString("ko-KR")}~${pricingGuide.guide_max.toLocaleString("ko-KR")}원, 중심 ${pricingGuide.guide_center.toLocaleString("ko-KR")}원
- 산식 주의: ${pricingGuide.notes.join(" / ")}

위 조건으로 단위 항목별 단가를 분석해 주세요. line_items는 해당 행사에 필요한 항목만 포함하세요.
고객 예산이 시장가보다 낮으면 추천 단가를 억지로 낮추지 말고 budget_realism.status를 below_market으로 표시하고 이유를 설명하세요.
진행 시간이 길거나 최소 경력이 높으면 본행사 진행비와 준비비를 현실적으로 상향 반영하세요.`;

      let analysisSource: "gemini" | "market_fallback" = "gemini";
      let analysis: PricingAnalysisResult | undefined;
      let geminiError: GeminiErrorDetail | null = null;

      // Gemini 호출 전체 시간 예산. 단가 분석은 정확성이 중요하므로 기본 25초까지 대기합니다.
      // AI_GEMINI_BUDGET_MS가 있으면 우선 사용하고, 없으면 GEMINI_MATCHING_TIMEOUT_MS를 공유합니다.
      const rawGeminiBudgetMs = Number(
        process.env.AI_GEMINI_BUDGET_MS ??
          process.env.GEMINI_MATCHING_TIMEOUT_MS ??
          25_000,
      );
      const TOTAL_GEMINI_BUDGET_MS = Number.isFinite(rawGeminiBudgetMs)
        ? Math.min(Math.max(rawGeminiBudgetMs, 5_000), 60_000)
        : 25_000;
      const MIN_ATTEMPT_MS = 3_000; // 이보다 시간이 적게 남으면 재시도 생략
      const deadline = Date.now() + TOTAL_GEMINI_BUDGET_MS;

      // 재시도 전략 (Vercel 함수 시간 제약 대응으로 경량화):
      // - thinkingBudget: 0 → gemini-2.5-flash 추론 비활성화로 지연 대폭 감소
      // - maxOutputTokens 축소 → 단가 분석 JSON은 ~800토큰이면 충분
      // - 남은 시간 예산 안에서만 재시도 (전체 합이 함수 한도 초과 방지)
      const callStrategies = [
        {
          label: "json-mode",
          options: {
            maxOutputTokens: 1024,
            responseMimeType: "application/json" as const,
            temperature: 0.15,
            thinkingBudget: 0,
          },
        },
        {
          label: "text-mode-retry",
          options: {
            maxOutputTokens: 1024,
            temperature: 0.25,
            thinkingBudget: 0,
            // responseMimeType 생략 → 시스템 프롬프트의 JSON 지시에 의존
          },
        },
      ];

      for (const strategy of callStrategies) {
        const remainingMs = deadline - Date.now();
        if (remainingMs < MIN_ATTEMPT_MS) {
          // 남은 시간이 부족하면 더 시도하지 않고 fallback으로 넘어감
          break;
        }

        try {
          const rawResponse = await callGemini(prompt, systemPrompt, {
            ...strategy.options,
            timeoutMs: remainingMs,
          });

          analysis = parsePricingJson(rawResponse);
          // 성공 → 루프 탈출
          break;
        } catch (err) {
          geminiError = getGeminiErrorDetail(err);
          logGeminiError(
            `[ai-pricing-analysis-${strategy.label}-failed]`,
            err,
            {
              request_id: body.request_id,
              strategy: strategy.label,
              remaining_ms: remainingMs,
              gemini_key_configured: Boolean(
                env.GEMINI_API_KEY || env.GOOGLE_API_KEY,
              ),
              gemini_model: env.GEMINI_MODEL,
            },
          );
        }
      }

      // 모든 시도 실패 시 fallback
      if (!analysis) {
        analysisSource = "market_fallback";
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
        market_data: { ...marketData, analysis_source: analysisSource, pricing_guide: pricingGuide },
        diagnostic: geminiError
          ? {
              analysis_source: analysisSource,
              gemini_status: geminiError.status,
              gemini_provider_status: geminiError.providerStatus,
              gemini_error_message:
                geminiError.providerMessage ?? geminiError.message,
            }
          : { analysis_source: analysisSource },
      });
    } catch (err) {
      next(err);
    }
  },
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
        return errorResponse(
          res,
          "NOT_FOUND",
          "예약을 찾을 수 없습니다.",
          [],
          404,
        );
      }

      if (
        ["completed", "canceled", "disputed"].includes(booking.booking_status)
      ) {
        return errorResponse(
          res,
          "CONFLICT",
          "이미 완료/취소된 예약은 단가를 변경할 수 없습니다.",
          [],
          409,
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
  },
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
        select: {
          id: true,
          customer_id: true,
          event_title: true,
          status: true,
        },
      });

      if (!request) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "요청서를 찾을 수 없습니다.",
          [],
          404,
        );
      }

      if (userType !== "admin" && request.customer_id !== userId) {
        return errorResponse(
          res,
          "FORBIDDEN",
          "본인 요청서만 수정할 수 있습니다.",
          [],
          403,
        );
      }

      if (["booked", "completed", "canceled"].includes(request.status)) {
        return errorResponse(
          res,
          "CONFLICT",
          "현재 상태에서는 예산을 수정할 수 없습니다.",
          [],
          409,
        );
      }

      const updated = await prisma.eventRequest.update({
        where: { id: req.params.id },
        data: { budget_min: body.budget_min, budget_max: body.budget_max },
      });

      return successResponse(
        res,
        updated,
        "예산이 AI 분석 결과로 업데이트되었습니다.",
      );
    } catch (err) {
      next(err);
    }
  },
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
        return errorResponse(
          res,
          "NOT_FOUND",
          "요청서 또는 프리랜서를 찾을 수 없습니다.",
          [],
          404,
        );
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
      if (
        axios.isAxiosError(err) &&
        err.config?.url?.includes("generativelanguage")
      ) {
        const detail = getGeminiErrorDetail(err);
        console.error("[ai-recommendation-reason-failed]", {
          gemini_error: detail,
        });
        return errorResponse(
          res,
          "GEMINI_REQUEST_FAILED",
          "AI 서비스 오류가 발생했습니다. Gemini 연결 상태를 확인해 주세요.",
          [detail],
          503,
        );
      }
      next(err);
    }
  },
);

export default router;
