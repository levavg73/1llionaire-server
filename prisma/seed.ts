import { PrismaClient, UserType, FreelancerStatus, RequestStatus, BookingStatus, PaymentStatus, SettlementStatus, ReviewStatus } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 시연용 seed 데이터 생성 시작...");

  // ── 관리자 계정 ──────────────────────────────────────────────
  const adminPassword = await bcrypt.hash(
    process.env.ADMIN_PASSWORD || "Admin1234!",
    12
  );
  const admin = await prisma.user.upsert({
    where: { email: process.env.ADMIN_EMAIL || "admin@freemic.co.kr" },
    update: {},
    create: {
      email: process.env.ADMIN_EMAIL || "admin@freemic.co.kr",
      name: "관리자",
      password_hash: adminPassword,
      user_type: UserType.admin,
      phone: "010-0000-0000",
    },
  });
  console.log("✅ 관리자 계정:", admin.email);

  // ── 고객 계정 ──────────────────────────────────────────────
  const customerPassword = await bcrypt.hash("Customer1234!", 12);
  const customer = await prisma.user.upsert({
    where: { email: "customer@freemic.co.kr" },
    update: {},
    create: {
      email: "customer@freemic.co.kr",
      name: "김고객",
      password_hash: customerPassword,
      user_type: UserType.customer,
      phone: "010-1234-5678",
      customer_profile: {
        create: {
          customer_type: "company",
          company_name: "주식회사 이벤트플러스",
          department: "마케팅팀",
          manager_name: "김고객",
        },
      },
    },
  });
  console.log("✅ 고객 계정:", customer.email);

  // ── 프리랜서 계정 1 (승인 완료) ────────────────────────────
  const freelancerPassword = await bcrypt.hash("Freelancer1234!", 12);
  const freelancer1 = await prisma.user.upsert({
    where: { email: "mc.park@freemic.co.kr" },
    update: {},
    create: {
      email: "mc.park@freemic.co.kr",
      name: "박진행",
      password_hash: freelancerPassword,
      user_type: UserType.freelancer,
      phone: "010-9876-5432",
      freelancer_profile: {
        create: {
          display_name: "MC 박진행",
          headline: "10년 경력의 전문 MC / 기업행사·컨퍼런스 전문",
          bio: "삼성, LG, 현대 등 대기업 행사 다수 진행. 청중과 소통하는 진행 스타일.",
          region: "서울",
          available_regions: ["경기", "인천", "부산"],
          categories: ["MC", "기업행사"],
          styles: ["정중한", "전문적"],
          career_years: 10,
          base_price_min: 500000,
          base_price_max: 1500000,
          languages: ["한국어", "영어"],
          script_writing_available: true,
          rehearsal_available: true,
          travel_available: true,
          status: FreelancerStatus.approved,
          approved_at: new Date(),
          avg_rating: 4.8,
          review_count: 12,
        },
      },
    },
  });
  console.log("✅ 프리랜서1 (승인):", freelancer1.email);

  // 포트폴리오 등록
  const freelancer1Profile = await prisma.freelancerProfile.findUnique({
    where: { user_id: freelancer1.id },
  });
  if (freelancer1Profile) {
    await prisma.portfolio.createMany({
      data: [
        {
          freelancer_id: freelancer1Profile.id,
          portfolio_type: "event_video",
          title: "2023 삼성 연간 시상식 MC",
          description: "삼성전자 2023년 임직원 시상식 공식 MC 진행",
          media_url: "https://www.youtube.com/watch?v=example1",
          category: "기업행사",
          is_representative: true,
          is_public: true,
        },
        {
          freelancer_id: freelancer1Profile.id,
          portfolio_type: "audio_sample",
          title: "음성 샘플 - 컨퍼런스 오프닝",
          description: "전문적인 컨퍼런스 오프닝 음성 샘플",
          media_url: "https://soundcloud.com/example/sample1",
          category: "컨퍼런스",
          is_representative: false,
          is_public: true,
        },
      ],
      skipDuplicates: true,
    });
  }

  // ── 프리랜서 계정 2 (검수 대기) ─────────────────────────────
  const freelancer2 = await prisma.user.upsert({
    where: { email: "host.lee@freemic.co.kr" },
    update: {},
    create: {
      email: "host.lee@freemic.co.kr",
      name: "이쇼호스트",
      password_hash: freelancerPassword,
      user_type: UserType.freelancer,
      phone: "010-5555-4444",
      freelancer_profile: {
        create: {
          display_name: "쇼호스트 이수진",
          headline: "라이브커머스 전문 쇼호스트 / 월 평균 5억 매출",
          bio: "홈쇼핑 출신 쇼호스트. 라이브커머스, 기업 홍보 영상 전문.",
          region: "서울",
          available_regions: ["전국"],
          categories: ["쇼호스트", "라이브커머스"],
          styles: ["활기찬", "친근한"],
          career_years: 6,
          base_price_min: 300000,
          base_price_max: 800000,
          languages: ["한국어"],
          status: FreelancerStatus.pending_review,
        },
      },
    },
  });
  console.log("✅ 프리랜서2 (검수중):", freelancer2.email);

  // ── 고객 요청서 ──────────────────────────────────────────────
  const eventRequest = await prisma.eventRequest.create({
    data: {
      customer_id: customer.id,
      event_title: "2024 하반기 임직원 포상 시상식",
      event_type: "기업행사",
      event_date: new Date("2024-11-15"),
      start_time: "14:00",
      end_time: "17:00",
      region: "서울",
      venue: "서울 그랜드 힐튼 호텔 컨벤션홀",
      budget_min: 500000,
      budget_max: 1000000,
      preferred_freelancer_type: ["MC"],
      preferred_styles: ["정중한", "전문적"],
      required_language: "한국어",
      script_required: true,
      rehearsal_required: true,
      travel_required: false,
      description: "임직원 300명 대상 연간 시상식 MC를 구합니다. 사전 리허설 필수.",
      status: RequestStatus.recommended,
    },
  });
  console.log("✅ 이벤트 요청서 생성:", eventRequest.event_title);

  // ── 후보 추천 ──────────────────────────────────────────────
  if (freelancer1Profile) {
    await prisma.recommendation.create({
      data: {
        request_id: eventRequest.id,
        freelancer_id: freelancer1Profile.id,
        recommended_by: admin.id,
        recommendation_reason:
          "10년 경력 기업행사 전문 MC로, 요청하신 행사 규모와 스타일에 최적입니다. 대기업 시상식 다수 진행 경험 보유.",
        display_order: 1,
        status: "sent",
      },
    });
  }
  console.log("✅ 후보 추천 생성");

  // ── 완료된 예약 + 후기 (평점 데모용) ──────────────────────────
  if (freelancer1Profile) {
    const completedBooking = await prisma.booking.create({
      data: {
        customer_id: customer.id,
        freelancer_id: freelancer1Profile.id,
        event_title: "2024 상반기 신제품 런칭 행사",
        event_date: new Date("2024-06-20"),
        start_time: "13:00",
        end_time: "16:00",
        venue: "코엑스 오디토리움",
        final_price: 800000,
        platform_fee: 80000,
        freelancer_amount: 720000,
        booking_status: BookingStatus.completed,
        payment_status: PaymentStatus.fully_paid,
        settlement_status: SettlementStatus.completed,
      },
    });

    await prisma.review.create({
      data: {
        booking_id: completedBooking.id,
        customer_id: customer.id,
        freelancer_id: freelancer1Profile.id,
        punctuality_score: 5,
        voice_delivery_score: 5,
        event_understanding_score: 5,
        atmosphere_score: 4,
        script_score: 5,
        response_score: 4,
        communication_score: 5,
        total_score: 4.7,
        rehire_intent: true,
        comment: "행사 진행을 매우 전문적으로 해주셨습니다. 사전 소통도 원활했고 현장 돌발상황도 잘 대처해주셨습니다.",
        status: ReviewStatus.published,
      },
    });
  }
  console.log("✅ 완료 예약 및 후기 생성");

  console.log("\n🎉 Seed 완료!");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("관리자   | admin@freemic.co.kr    | Admin1234!");
  console.log("고객     | customer@freemic.co.kr | Customer1234!");
  console.log("프리랜서 | mc.park@freemic.co.kr  | Freelancer1234!");
  console.log("프리랜서 | host.lee@freemic.co.kr | Freelancer1234!");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main()
  .catch((e) => {
    console.error("❌ Seed 실패:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
