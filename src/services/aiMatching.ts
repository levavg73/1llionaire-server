import { Prisma } from "@prisma/client";
import axios from "axios";
import { env, requireGeminiKey } from "../config/env";
import { createProfileImageSignedUrl } from "../utils/profileImages";

const TOP_RECOMMENDATION_COUNT = 5;
const AI_RECOMMENDATION_POOL_SIZE = 10;
const MAX_AI_IMAGE_COUNT = 10;
const MAX_AI_IMAGE_BYTES = 1_500_000;

const EVENT_TYPE_SYNONYMS: Record<string, string[]> = {
  "기업행사": ["기업행사", "기업", "행사", "mc", "기업행사 mc", "컨퍼런스", "시상식"],
  "웨딩": ["웨딩", "결혼식", "사회자", "웨딩 사회자"],
  "웨딩 사회자": ["웨딩", "결혼식", "사회자", "웨딩 사회자"],
  "쇼호스트": ["쇼호스트", "라이브커머스", "홈쇼핑", "커머스"],
  "라이브커머스": ["라이브커머스", "쇼호스트", "커머스", "홈쇼핑"],
  "컨퍼런스": ["컨퍼런스", "포럼", "세미나", "기업행사", "mc"],
  "컨퍼런스 MC": ["컨퍼런스", "컨퍼런스 mc", "포럼", "세미나", "기업행사", "mc"],
  "아나운서": ["아나운서", "mc", "진행", "사회"],
};

type RequestForMatching = {
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
};

type MatchingCandidate = {
  id: string;
  display_name: string | null;
  profile_image_url: string | null;
  profile_image_path: string | null;
  headline: string | null;
  bio: string | null;
  region: string | null;
  available_regions: string[];
  categories: string[];
  styles: string[];
  languages: string[];
  career_years: number | null;
  base_price_min: number | null;
  base_price_max: number | null;
  script_writing_available: boolean;
  rehearsal_available: boolean;
  travel_available: boolean;
  voice_score: number | null;
  avg_rating: number | null;
  review_count: number;
  bookings: Array<{
    event_date: Date;
    start_time: string;
    end_time: string;
    booking_status: string;
  }>;
  portfolios: Array<{
    portfolio_type: string;
    title: string;
    description: string | null;
    media_url: string;
    thumbnail_url: string | null;
    category: string | null;
    is_representative: boolean;
  }>;
  reviews: Array<{
    punctuality_score: number;
    voice_delivery_score: number;
    event_understanding_score: number;
    atmosphere_score: number;
    script_score: number;
    response_score: number;
    communication_score: number;
    total_score: number;
    rehire_intent: boolean;
    comment: string | null;
    booking: {
      event_title: string;
      event_date: Date;
    };
  }>;
};

type CandidateScore = {
  candidate: MatchingCandidate;
  score: number;
  reasons: string[];
};

type RecommendationDraft = {
  scored: CandidateScore;
  recommendationReason: string;
  aiScore?: number;
};

type GeminiResponsePart = {
  text?: string;
};

type GeminiCandidate = {
  content?: {
    parts?: GeminiResponsePart[];
    role?: string;
  };
  finishReason?: string;
};

type GeminiGenerateContentResponse = {
  candidates?: GeminiCandidate[];
  promptFeedback?: {
    blockReason?: string;
  };
  error?: {
    code?: number;
    message?: string;
    status?: string;
  } | null;
};

type GeminiContentPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

type AiRecommendationResponse = {
  recommendations?: Array<{
    freelancer_id?: string;
    match_score?: number;
    recommendation_reason?: string;
    reason?: string;
  }>;
};


function normalize(value?: string | null) {
  return (value ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·ㆍ|/\\_-]/g, "")
    .trim();
}

function expandEventKeywords(eventType: string, preferredTypes: string[]) {
  const rawKeywords = [eventType, ...preferredTypes];
  const expanded = new Set<string>();

  rawKeywords.forEach((keyword) => {
    if (!keyword) return;
    expanded.add(normalize(keyword));

    const synonyms = EVENT_TYPE_SYNONYMS[keyword] ?? EVENT_TYPE_SYNONYMS[keyword.trim()];
    synonyms?.forEach((synonym) => expanded.add(normalize(synonym)));
  });

  return [...expanded].filter(Boolean);
}

function listHasKeywordMatch(list: string[], keywords: string[]) {
  const normalizedList = list.map(normalize).filter(Boolean);

  return normalizedList.some((item) =>
    keywords.some((keyword) => item.includes(keyword) || keyword.includes(item))
  );
}

function countMatches(list: string[], targets: string[]) {
  const normalizedList = list.map(normalize).filter(Boolean);
  const normalizedTargets = targets.map(normalize).filter(Boolean);

  return normalizedTargets.filter((target) =>
    normalizedList.some((item) => item.includes(target) || target.includes(item))
  ).length;
}

function isRegionMatch(requestRegion: string, candidate: MatchingCandidate) {
  const target = normalize(requestRegion);
  const home = normalize(candidate.region);
  const availableRegions = candidate.available_regions.map(normalize);

  if (!target) return false;
  if (home && (home.includes(target) || target.includes(home))) return true;

  return availableRegions.some(
    (region) =>
      region === "전국" || region.includes(target) || target.includes(region)
  );
}

function isSameDate(left: Date, right: Date) {
  return left.toISOString().slice(0, 10) === right.toISOString().slice(0, 10);
}

function isTimeOverlap(startA: string, endA: string, startB: string, endB: string) {
  return startA < endB && startB < endA;
}

function hasScheduleConflict(request: RequestForMatching, candidate: MatchingCandidate) {
  return candidate.bookings.some((booking) => {
    if (["canceled", "completed"].includes(booking.booking_status)) return false;
    if (!isSameDate(request.event_date, booking.event_date)) return false;

    return isTimeOverlap(
      request.start_time,
      request.end_time,
      booking.start_time,
      booking.end_time
    );
  });
}

function isBudgetMatch(request: RequestForMatching, candidate: MatchingCandidate) {
  const requestMin = request.budget_min ?? 0;
  const requestMax = request.budget_max ?? Number.MAX_SAFE_INTEGER;
  const candidateMin = candidate.base_price_min ?? 0;
  const candidateMax = candidate.base_price_max ?? Number.MAX_SAFE_INTEGER;

  return candidateMin <= requestMax && requestMin <= candidateMax;
}

function scoreCandidate(request: RequestForMatching, candidate: MatchingCandidate): CandidateScore | null {
  if (hasScheduleConflict(request, candidate)) {
    return null;
  }

  const reasons: string[] = [];
  let score = 0;

  const eventKeywords = expandEventKeywords(
    request.event_type,
    request.preferred_freelancer_type
  );

  if (listHasKeywordMatch(candidate.categories, eventKeywords)) {
    score += 34;
    reasons.push("행사 분야 적합");
  }

  if (isRegionMatch(request.region, candidate)) {
    score += 18;
    reasons.push("지역 조건 적합");
  }

  if (request.budget_min || request.budget_max) {
    if (isBudgetMatch(request, candidate)) {
      score += 16;
      reasons.push("예산 범위 적합");
    } else {
      score -= 12;
    }
  }

  const styleMatches = countMatches(candidate.styles, request.preferred_styles);
  if (styleMatches > 0) {
    score += Math.min(12, styleMatches * 4);
    reasons.push("선호 스타일 일치");
  }

  if (request.required_language) {
    if (listHasKeywordMatch(candidate.languages, [request.required_language])) {
      score += 8;
      reasons.push("필요 언어 가능");
    } else {
      score -= 8;
    }
  }

  if (request.script_required) {
    if (candidate.script_writing_available) {
      score += 7;
      reasons.push("대본 작성 가능");
    } else {
      score -= 12;
    }
  }

  if (request.rehearsal_required) {
    if (candidate.rehearsal_available) {
      score += 6;
      reasons.push("리허설 가능");
    } else {
      score -= 10;
    }
  }

  if (request.travel_required) {
    if (candidate.travel_available) {
      score += 6;
      reasons.push("출장 가능");
    } else {
      score -= 10;
    }
  }

  if (candidate.avg_rating) {
    score += Math.min(8, candidate.avg_rating * 1.6);
    reasons.push(`평점 ${candidate.avg_rating.toFixed(1)}점`);
  }

  if (candidate.review_count > 0) {
    score += Math.min(5, candidate.review_count / 5);
  }

  if (candidate.career_years) {
    score += Math.min(7, candidate.career_years * 0.6);
    if (candidate.career_years >= 5) reasons.push(`${candidate.career_years}년 경력`);
  }

  if (candidate.voice_score) {
    score += Math.min(4, candidate.voice_score);
  }

  if (score < 12) return null;

  return {
    candidate,
    score: Math.round(score * 10) / 10,
    reasons,
  };
}


function truncate(value: string | null | undefined, maxLength: number) {
  if (!value) return null;

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function formatDateForAi(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getImageMimeFromUrl(url: string) {
  const cleanUrl = url.split("?")[0].toLowerCase();
  if (cleanUrl.endsWith(".png")) return "image/png";
  if (cleanUrl.endsWith(".webp")) return "image/webp";
  if (cleanUrl.endsWith(".jpg") || cleanUrl.endsWith(".jpeg")) return "image/jpeg";
  return null;
}

function normalizeImageMime(contentType: string | undefined, url: string) {
  const mimeType = contentType?.split(";")[0]?.trim().toLowerCase();

  if (["image/jpeg", "image/png", "image/webp"].includes(mimeType ?? "")) {
    return mimeType!;
  }

  return getImageMimeFromUrl(url);
}

async function fetchImageAsGeminiPart(url: string): Promise<GeminiContentPart | null> {
  try {
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 6_000,
      maxContentLength: MAX_AI_IMAGE_BYTES,
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.1",
      },
    });

    const buffer = Buffer.from(response.data);
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_AI_IMAGE_BYTES) return null;

    const contentTypeHeader = response.headers["content-type"];
    const contentType = Array.isArray(contentTypeHeader)
      ? contentTypeHeader[0]
      : contentTypeHeader?.toString();
    const mimeType = normalizeImageMime(contentType, url);
    if (!mimeType) return null;

    return {
      inlineData: {
        mimeType,
        data: buffer.toString("base64"),
      },
    };
  } catch (err) {
    console.warn("[ai-recommendation-image-fetch-failed]", { url, err });
    return null;
  }
}

async function callGeminiWithParts(
  parts: GeminiContentPart[],
  systemPrompt: string,
  maxOutputTokens = 4096
) {
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
          parts,
        },
      ],
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      generationConfig: {
        temperature: 0.35,
        maxOutputTokens,
        responseMimeType: "application/json",
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

function parseAiRecommendationJson(raw: string): AiRecommendationResponse {
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) ?? raw.match(/({[\s\S]*})/);
  const jsonStr = jsonMatch ? jsonMatch[1] : raw;
  return JSON.parse(jsonStr.trim()) as AiRecommendationResponse;
}

function sanitizeAiReason(reason: string | null | undefined) {
  const normalized = truncate(reason, 500);
  if (!normalized || normalized.length < 30) return null;
  return normalized;
}

function buildRequestContextForAi(request: RequestForMatching) {
  return {
    id: request.id,
    event_title: request.event_title ?? null,
    event_type: request.event_type,
    event_date: formatDateForAi(request.event_date),
    start_time: request.start_time,
    end_time: request.end_time,
    region: request.region,
    venue: request.venue ?? null,
    budget_min: request.budget_min,
    budget_max: request.budget_max,
    preferred_freelancer_type: request.preferred_freelancer_type,
    preferred_styles: request.preferred_styles,
    required_language: request.required_language,
    script_required: request.script_required,
    rehearsal_required: request.rehearsal_required,
    travel_required: request.travel_required,
    description: truncate(request.description, 1000),
    attachment_url: request.attachment_url ?? null,
  };
}

function buildCandidateContextForAi(scored: CandidateScore) {
  const candidate = scored.candidate;

  return {
    freelancer_id: candidate.id,
    display_name: candidate.display_name,
    headline: truncate(candidate.headline, 160),
    bio: truncate(candidate.bio, 800),
    region: candidate.region,
    available_regions: candidate.available_regions,
    categories: candidate.categories,
    styles: candidate.styles,
    languages: candidate.languages,
    career_years: candidate.career_years,
    base_price_min: candidate.base_price_min,
    base_price_max: candidate.base_price_max,
    script_writing_available: candidate.script_writing_available,
    rehearsal_available: candidate.rehearsal_available,
    travel_available: candidate.travel_available,
    voice_score: candidate.voice_score,
    avg_rating: candidate.avg_rating,
    review_count: candidate.review_count,
    rule_based_score: scored.score,
    rule_based_reasons: scored.reasons,
    portfolios: candidate.portfolios.map((portfolio) => ({
      type: portfolio.portfolio_type,
      title: truncate(portfolio.title, 120),
      description: truncate(portfolio.description, 250),
      category: portfolio.category,
      is_representative: portfolio.is_representative,
      has_media: Boolean(portfolio.media_url || portfolio.thumbnail_url),
      media_url: portfolio.media_url,
      thumbnail_url: portfolio.thumbnail_url,
    })),
    reviews: candidate.reviews.map((review) => ({
      event_title: truncate(review.booking.event_title, 120),
      event_date: formatDateForAi(review.booking.event_date),
      total_score: review.total_score,
      rehire_intent: review.rehire_intent,
      scores: {
        punctuality: review.punctuality_score,
        voice_delivery: review.voice_delivery_score,
        event_understanding: review.event_understanding_score,
        atmosphere: review.atmosphere_score,
        script: review.script_score,
        response: review.response_score,
        communication: review.communication_score,
      },
      comment: truncate(review.comment, 350),
    })),
  };
}

type CandidateImageSource = {
  candidateLabel: string;
  label: string;
  url: string;
};

async function collectCandidateImageSources(scored: CandidateScore): Promise<CandidateImageSource[]> {
  const candidate = scored.candidate;
  const candidateLabel = `${candidate.display_name ?? "이름 미등록"}(${candidate.id})`;
  const profileImageUrl =
    candidate.profile_image_url ?? await createProfileImageSignedUrl(candidate.profile_image_path);

  return [
    ...(profileImageUrl
      ? [{ candidateLabel, label: "profile_image", url: profileImageUrl }]
      : []),
    ...candidate.portfolios
      .slice(0, 2)
      .map((portfolio, index) => ({
        candidateLabel,
        label: `portfolio_image_${index + 1}: ${portfolio.title}`,
        url: portfolio.thumbnail_url ?? portfolio.media_url,
      }))
      .filter((source): source is CandidateImageSource => Boolean(source.url)),
  ];
}

async function collectCandidateImageParts(ranked: CandidateScore[]) {
  const candidateImageSources = (
    await Promise.all(ranked.map((scored) => collectCandidateImageSources(scored)))
  )
    .flat()
    .slice(0, MAX_AI_IMAGE_COUNT);

  const fetchedImages = await Promise.all(
    candidateImageSources.map(async (source) => ({
      source,
      imagePart: await fetchImageAsGeminiPart(source.url),
    }))
  );

  return fetchedImages.flatMap(({ source, imagePart }) => {
    if (!imagePart) return [];

    return [
      {
        text: `다음 이미지는 후보 ${source.candidateLabel}의 ${source.label}입니다. 이 이미지에서 확인 가능한 분위기/전문성 단서만 추천 사유에 반영하세요.`,
      },
      imagePart,
    ];
  });
}

function buildAiRecommendationSystemPrompt() {
  return [
    "당신은 행사 진행자/MC 매칭 전문가입니다.",
    "고객 요청서와 후보별 자기소개, 후기, 포트폴리오, 프로필/포트폴리오 이미지를 근거로 최종 추천 순서와 추천 사유를 작성합니다.",
    "추천 사유는 고객에게 바로 노출됩니다. 한국어 존댓말로 자연스럽고 구체적으로 작성하세요.",
    "각 추천 사유에는 요청서 조건과 실제 후보 근거를 최소 2개 이상 연결하세요. 예: 행사 유형, 지역, 스타일, 언어, 대본/리허설/출장 가능 여부, 후기 내용, 포트폴리오 사례, 이미지에서 보이는 분위기.",
    "후기/소개/포트폴리오/이미지에서 확인되지 않는 경력이나 실적은 절대 지어내지 마세요.",
    "이미지 내용은 명확히 확인되는 경우에만 언급하고, 불확실하면 '포트폴리오 자료를 확인할 수 있어'처럼 보수적으로 표현하세요.",
    "'조건 기반 매칭 결과' 같은 일반 문구만 반복하지 마세요.",
    "반드시 JSON만 반환하세요. 마크다운, 설명문, 코드블록은 금지입니다.",
  ].join("\n");
}

function buildAiRecommendationUserPrompt(request: RequestForMatching, ranked: CandidateScore[]) {
  return JSON.stringify(
    {
      task: "아래 고객 요청서에 가장 적합한 진행자 최대 5명을 추천 순서대로 고르고, 각 후보별 추천 사유를 작성하세요.",
      output_schema: {
        recommendations: [
          {
            freelancer_id: "후보 ID",
            match_score: "0부터 100 사이 숫자",
            recommendation_reason: "고객에게 보여줄 2~3문장 추천 사유",
          },
        ],
      },
      request: buildRequestContextForAi(request),
      candidates: ranked.map(buildCandidateContextForAi),
    },
    null,
    2
  );
}

async function buildAiRecommendationDrafts(
  request: RequestForMatching,
  ranked: CandidateScore[]
): Promise<RecommendationDraft[]> {
  if (ranked.length === 0) return [];

  try {
    const prompt = buildAiRecommendationUserPrompt(request, ranked);
    const imageParts = await collectCandidateImageParts(ranked);
    const raw = await callGeminiWithParts(
      [{ text: prompt }, ...imageParts],
      buildAiRecommendationSystemPrompt()
    );
    const parsed = parseAiRecommendationJson(raw);
    const scoredById = new Map(ranked.map((item) => [item.candidate.id, item]));
    const selectedIds = new Set<string>();
    const drafts: RecommendationDraft[] = [];

    for (const recommendation of parsed.recommendations ?? []) {
      if (!recommendation.freelancer_id || selectedIds.has(recommendation.freelancer_id)) {
        continue;
      }

      const scored = scoredById.get(recommendation.freelancer_id);
      if (!scored) continue;

      const recommendationReason = sanitizeAiReason(
        recommendation.recommendation_reason ?? recommendation.reason
      );

      drafts.push({
        scored,
        recommendationReason: recommendationReason ?? buildRecommendationReason(scored),
        aiScore: typeof recommendation.match_score === "number" ? recommendation.match_score : undefined,
      });
      selectedIds.add(recommendation.freelancer_id);
    }

    const remaining = ranked
      .filter((item) => !selectedIds.has(item.candidate.id))
      .map((scored) => ({
        scored,
        recommendationReason: buildRecommendationReason(scored),
      }));

    return [...drafts, ...remaining].slice(0, TOP_RECOMMENDATION_COUNT);
  } catch (err) {
    console.error("[ai-recommendation-reason-generation-failed]", err);
    return ranked.slice(0, TOP_RECOMMENDATION_COUNT).map((scored) => ({
      scored,
      recommendationReason: buildRecommendationReason(scored),
    }));
  }
}

function buildRecommendationReason(scored: CandidateScore) {
  const primaryReasons = scored.reasons.slice(0, 4);
  const displayName = scored.candidate.display_name || "해당 진행자";

  if (primaryReasons.length === 0) {
    return `조건 기반 매칭 결과, ${displayName}님이 요청 조건과 잘 맞는 후보로 추천되었습니다.`;
  }

  return `조건 기반 매칭 결과, ${primaryReasons.join(" · ")} 기준으로 ${displayName}님이 요청 조건과 잘 맞습니다.`;
}

export async function generateAiRecommendationsForRequest(params: {
  tx: Prisma.TransactionClient;
  request: RequestForMatching;
  recommendedByUserId: string;
  excludedFreelancerIds?: string[];
  startingDisplayOrder?: number;
}) {
  const {
    tx,
    request,
    recommendedByUserId,
    excludedFreelancerIds = [],
    startingDisplayOrder = 1,
  } = params;

  const candidates = await tx.freelancerProfile.findMany({
    where: {
      status: "approved",
      ...(excludedFreelancerIds.length > 0 && { id: { notIn: excludedFreelancerIds } }),
    },
    select: {
      id: true,
      display_name: true,
      profile_image_url: true,
      profile_image_path: true,
      headline: true,
      bio: true,
      region: true,
      available_regions: true,
      categories: true,
      styles: true,
      languages: true,
      career_years: true,
      base_price_min: true,
      base_price_max: true,
      script_writing_available: true,
      rehearsal_available: true,
      travel_available: true,
      voice_score: true,
      avg_rating: true,
      review_count: true,
      bookings: {
        where: {
          booking_status: { notIn: ["canceled", "completed"] },
        },
        select: {
          event_date: true,
          start_time: true,
          end_time: true,
          booking_status: true,
        },
      },
      portfolios: {
        where: { is_public: true },
        orderBy: { created_at: "desc" },
        take: 5,
        select: {
          portfolio_type: true,
          title: true,
          description: true,
          media_url: true,
          thumbnail_url: true,
          category: true,
          is_representative: true,
        },
      },
      reviews: {
        where: { status: "published" },
        orderBy: { created_at: "desc" },
        take: 5,
        select: {
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
          booking: {
            select: {
              event_title: true,
              event_date: true,
            },
          },
        },
      },
    },
  });

  const ranked = candidates
    .map((candidate) => scoreCandidate(request, candidate))
    .filter((item): item is CandidateScore => Boolean(item))
    .sort((a, b) => b.score - a.score)
    .slice(0, AI_RECOMMENDATION_POOL_SIZE);

  if (ranked.length === 0) {
    return {
      count: 0,
      status: "submitted",
    };
  }

  const recommendationDrafts = await buildAiRecommendationDrafts(request, ranked);

  await tx.recommendation.createMany({
    data: recommendationDrafts.map((item, index) => ({
      request_id: request.id,
      freelancer_id: item.scored.candidate.id,
      recommended_by: recommendedByUserId,
      recommendation_reason: item.recommendationReason,
      display_order: startingDisplayOrder + index,
      status: "sent",
    })),
    skipDuplicates: true,
  });

  const updatedRequest = await tx.eventRequest.update({
    where: { id: request.id },
    data: { status: "recommended" },
  });

  return {
    count: recommendationDrafts.length,
    status: updatedRequest.status,
  };
}
