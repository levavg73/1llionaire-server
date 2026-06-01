-- Demo public reviews for approved freelancer profiles.
-- This migration creates published review rows so review_count and detail review content match.

WITH demo_reviewers AS (
  INSERT INTO users (
    id,
    user_type,
    name,
    email,
    password_hash,
    phone,
    is_active,
    created_at,
    updated_at
  )
  SELECT
    'demo-review-customer-' || n,
    'customer',
    CASE ((n - 1) % 12) + 1
      WHEN 1 THEN '김민지'
      WHEN 2 THEN '박서준'
      WHEN 3 THEN '이하늘'
      WHEN 4 THEN '최유진'
      WHEN 5 THEN '정도윤'
      WHEN 6 THEN '한지우'
      WHEN 7 THEN '오세린'
      WHEN 8 THEN '윤태현'
      WHEN 9 THEN '강나래'
      WHEN 10 THEN '서지훈'
      WHEN 11 THEN '문채원'
      ELSE '임수아'
    END,
    'demo.reviewer' || n || '@freemic.local',
    'seeded-review-user',
    NULL,
    true,
    NOW(),
    NOW()
  FROM generate_series(1, 40) AS n
  ON CONFLICT (email) DO UPDATE SET
    name = EXCLUDED.name,
    updated_at = NOW()
  RETURNING id
), target_profiles AS (
  SELECT
    id,
    display_name,
    COALESCE(NULLIF(review_count, 0), 6) AS target_count,
    COALESCE(base_price_min, 500000) AS base_price_min
  FROM freelancer_profiles
  WHERE status = 'approved'
), numbered_reviews AS (
  SELECT
    p.id AS freelancer_id,
    p.display_name,
    p.base_price_min,
    gs.n
  FROM target_profiles p
  CROSS JOIN LATERAL generate_series(1, LEAST(GREATEST(p.target_count, 3), 40)) AS gs(n)
), upsert_bookings AS (
  INSERT INTO bookings (
    id,
    customer_id,
    freelancer_id,
    event_title,
    event_date,
    start_time,
    end_time,
    venue,
    final_price,
    platform_fee,
    freelancer_amount,
    booking_status,
    payment_status,
    settlement_status,
    created_at,
    updated_at
  )
  SELECT
    'demo-review-booking-' || nr.freelancer_id || '-' || nr.n,
    'demo-review-customer-' || (((nr.n - 1) % 40) + 1),
    nr.freelancer_id,
    CASE ((nr.n - 1) % 10) + 1
      WHEN 1 THEN '기업 임직원 시상식'
      WHEN 2 THEN '웨딩 본식 사회'
      WHEN 3 THEN '브랜드 런칭 쇼케이스'
      WHEN 4 THEN '스타트업 컨퍼런스'
      WHEN 5 THEN '라이브커머스 특별 방송'
      WHEN 6 THEN 'VIP 초청 세미나'
      WHEN 7 THEN '사내 타운홀 미팅'
      WHEN 8 THEN '국제 포럼 세션'
      WHEN 9 THEN '제품 발표회'
      ELSE '연말 네트워킹 파티'
    END,
    (CURRENT_DATE - (nr.n * 17 || ' days')::interval)::timestamp,
    '14:00',
    '16:00',
    CASE ((nr.n - 1) % 6) + 1
      WHEN 1 THEN '서울 코엑스'
      WHEN 2 THEN '서울 신라호텔'
      WHEN 3 THEN '판교 테크노밸리'
      WHEN 4 THEN '부산 벡스코'
      WHEN 5 THEN '온라인 라이브 스튜디오'
      ELSE '서울 콘래드 호텔'
    END,
    nr.base_price_min,
    ROUND(nr.base_price_min * 0.1)::int,
    nr.base_price_min - ROUND(nr.base_price_min * 0.1)::int,
    'completed',
    'fully_paid',
    'completed',
    NOW() - (nr.n * interval '17 days'),
    NOW() - (nr.n * interval '17 days')
  FROM numbered_reviews nr
  ON CONFLICT (id) DO UPDATE SET
    event_title = EXCLUDED.event_title,
    event_date = EXCLUDED.event_date,
    venue = EXCLUDED.venue,
    booking_status = 'completed',
    payment_status = 'fully_paid',
    settlement_status = 'completed',
    updated_at = NOW()
  RETURNING id
), upsert_reviews AS (
  INSERT INTO reviews (
    id,
    booking_id,
    customer_id,
    freelancer_id,
    punctuality_score,
    voice_delivery_score,
    event_understanding_score,
    atmosphere_score,
    script_score,
    response_score,
    communication_score,
    total_score,
    rehire_intent,
    comment,
    status,
    created_at,
    updated_at
  )
  SELECT
    'demo-review-' || nr.freelancer_id || '-' || nr.n,
    'demo-review-booking-' || nr.freelancer_id || '-' || nr.n,
    'demo-review-customer-' || (((nr.n - 1) % 40) + 1),
    nr.freelancer_id,
    5,
    CASE WHEN nr.n % 7 = 0 THEN 4 ELSE 5 END,
    5,
    CASE WHEN nr.n % 5 = 0 THEN 4 ELSE 5 END,
    CASE WHEN nr.n % 6 = 0 THEN 4 ELSE 5 END,
    5,
    CASE WHEN nr.n % 8 = 0 THEN 4 ELSE 5 END,
    CASE
      WHEN nr.n % 7 = 0 THEN 4.7
      WHEN nr.n % 5 = 0 THEN 4.8
      ELSE 4.9
    END,
    true,
    CASE ((nr.n - 1) % 12) + 1
      WHEN 1 THEN '사전 미팅부터 현장 진행까지 정말 안정적이었습니다. 행사 흐름을 잘 잡아주셔서 참석자 반응도 좋았습니다.'
      WHEN 2 THEN '목소리 전달력이 좋고 순발력이 뛰어났습니다. 갑작스러운 순서 변경도 자연스럽게 이어주셨어요.'
      WHEN 3 THEN '대본 이해도가 높아서 별도 설명이 많지 않아도 원하는 톤으로 진행해 주셨습니다.'
      WHEN 4 THEN '고객사 임원진이 있는 자리라 걱정했는데 차분하고 전문적으로 분위기를 만들어주셨습니다.'
      WHEN 5 THEN '현장 스태프와의 커뮤니케이션이 빠르고 정확했습니다. 다음 행사에도 다시 요청하고 싶습니다.'
      WHEN 6 THEN '참석자 참여를 자연스럽게 이끌어주셔서 행사가 지루하지 않았습니다.'
      WHEN 7 THEN '리허설 때부터 꼼꼼하게 체크해주셔서 본 행사 진행이 매우 매끄러웠습니다.'
      WHEN 8 THEN '브랜드 메시지를 잘 살려주셨고, 전체적인 진행 톤이 행사 성격과 잘 맞았습니다.'
      WHEN 9 THEN '시간 관리가 정확했고, 마무리 멘트까지 깔끔했습니다.'
      WHEN 10 THEN '외국인 참석자가 있는 행사였는데 언어 대응도 자연스러워서 만족도가 높았습니다.'
      WHEN 11 THEN '밝은 에너지와 안정적인 진행이 모두 좋았습니다. 현장 분위기가 훨씬 좋아졌습니다.'
      ELSE '가격 대비 만족도가 높았습니다. 상담 응답도 빠르고 준비 과정도 체계적이었습니다.'
    END,
    'published',
    NOW() - (nr.n * interval '17 days'),
    NOW() - (nr.n * interval '17 days')
  FROM numbered_reviews nr
  ON CONFLICT (id) DO UPDATE SET
    punctuality_score = EXCLUDED.punctuality_score,
    voice_delivery_score = EXCLUDED.voice_delivery_score,
    event_understanding_score = EXCLUDED.event_understanding_score,
    atmosphere_score = EXCLUDED.atmosphere_score,
    script_score = EXCLUDED.script_score,
    response_score = EXCLUDED.response_score,
    communication_score = EXCLUDED.communication_score,
    total_score = EXCLUDED.total_score,
    rehire_intent = EXCLUDED.rehire_intent,
    comment = EXCLUDED.comment,
    status = 'published',
    updated_at = NOW()
  RETURNING freelancer_id
), review_stats AS (
  SELECT
    freelancer_id,
    COUNT(*)::int AS published_review_count,
    ROUND(AVG(total_score)::numeric, 1)::float AS published_avg_rating
  FROM reviews
  WHERE status = 'published'
  GROUP BY freelancer_id
)
UPDATE freelancer_profiles fp
SET
  review_count = rs.published_review_count,
  avg_rating = rs.published_avg_rating,
  updated_at = NOW()
FROM review_stats rs
WHERE fp.id = rs.freelancer_id;
