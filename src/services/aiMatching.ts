import { Prisma } from "@prisma/client";

const TOP_RECOMMENDATION_COUNT = 5;

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
  event_type: string;
  event_date: Date;
  start_time: string;
  end_time: string;
  region: string;
  budget_min: number | null;
  budget_max: number | null;
  preferred_freelancer_type: string[];
  preferred_styles: string[];
  required_language: string | null;
  script_required: boolean;
  rehearsal_required: boolean;
  travel_required: boolean;
};

type MatchingCandidate = {
  id: string;
  display_name: string | null;
  headline: string | null;
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
};

type CandidateScore = {
  candidate: MatchingCandidate;
  score: number;
  reasons: string[];
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
      headline: true,
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
    },
  });

  const ranked = candidates
    .map((candidate) => scoreCandidate(request, candidate))
    .filter((item): item is CandidateScore => Boolean(item))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_RECOMMENDATION_COUNT);

  if (ranked.length === 0) {
    return {
      count: 0,
      status: "submitted",
    };
  }

  await tx.recommendation.createMany({
    data: ranked.map((item, index) => ({
      request_id: request.id,
      freelancer_id: item.candidate.id,
      recommended_by: recommendedByUserId,
      recommendation_reason: buildRecommendationReason(item),
      display_order: startingDisplayOrder + index,
      status: "draft",
    })),
    skipDuplicates: true,
  });

  const updatedRequest = await tx.eventRequest.update({
    where: { id: request.id },
    data: { status: "recommending" },
  });

  return {
    count: ranked.length,
    status: updatedRequest.status,
  };
}
