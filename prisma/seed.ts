/// <reference types="node" />
import {
  PrismaClient,
  UserType,
  FreelancerStatus,
  RequestStatus,
  RecommendationStatus,
  BookingStatus,
  PaymentStatus,
  SettlementStatus,
  ReviewStatus,
  EscrowStatus,
  ContractStatus,
  PaymentStatusToss,
} from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const PASSWORDS = {
  admin: "Admin1234!",
  customer: "Customer1234!",
  freelancer: "Freelancer1234!",
};

type FreelancerSeed = {
  email: string;
  name: string;
  phone: string;
  profileId: string;
  displayName: string;
  image: string;
  headline: string;
  bio: string;
  region: string;
  availableRegions: string[];
  categories: string[];
  styles: string[];
  careerYears: number;
  priceMin: number;
  priceMax: number;
  languages: string[];
  script: boolean;
  rehearsal: boolean;
  travel: boolean;
  avgRating: number;
  reviewCount: number;
  review: {
    bookingId: string;
    reviewId: string;
    freelancerReviewId: string;
    eventTitle: string;
    eventDate: Date;
    venue: string;
    finalPrice: number;
    scores: [number, number, number, number, number, number, number];
    totalScore: number;
    comment: string;
  };
};

type ReviewCustomerSeed = {
  name: string;
  companyName: string;
  department: string;
  managerName?: string;
};

const FREELANCERS: FreelancerSeed[] = [
  {
    email: "mc.shin@voit.co.kr",
    name: "신동현",
    phone: "010-2301-7007",
    profileId: "seed_profile_shin_donghyun",
    displayName: "MC 신동현",
    image: "/seed-profiles/shin-donghyun.svg",
    headline: "스타트업·투자 행사 MC | 데모데이·IR 피칭 행사 전문",
    bio: "7년간 VC, 액셀러레이터, 스타트업 생태계 행사를 전문으로 진행했습니다. 빠른 진행 속도와 스타트업 문화에 대한 깊은 이해로 데모데이, IR 발표, 해커톤에서 특히 강합니다.",
    region: "서울",
    availableRegions: ["서울", "경기", "인천", "대전"],
    categories: ["컨퍼런스 MC", "기업행사 MC", "스타트업 행사"],
    styles: ["활기찬", "트렌디한", "순발력 있는"],
    careerYears: 7,
    priceMin: 600000,
    priceMax: 1300000,
    languages: ["한국어", "영어"],
    script: true,
    rehearsal: true,
    travel: true,
    avgRating: 4.7,
    reviewCount: 4,
    review: {
      bookingId: "seed_booking_shin_donghyun_001",
      reviewId: "seed_review_shin_donghyun_001",
      freelancerReviewId: "seed_freelancer_review_shin_donghyun_001",
      eventTitle: "2026 초기창업패키지 데모데이",
      eventDate: new Date("2026-04-06T00:00:00.000Z"),
      venue: "서울창업허브 공덕",
      finalPrice: 950000,
      scores: [5, 4, 5, 4, 4, 5, 5],
      totalScore: 4.7,
      comment:
        "IR 발표 흐름을 정확히 이해하고, 심사위원 질의응답 전환도 매끄럽게 잡아주었습니다. 스타트업 행사에 정말 잘 맞는 진행자였습니다.",
    },
  },
  {
    email: "announcer.edu@voit.co.kr",
    name: "한서윤",
    phone: "010-2402-6006",
    profileId: "seed_profile_han_seoyun",
    displayName: "아나운서 한서윤",
    image: "/seed-profiles/han-seoyun.svg",
    headline: "교육·공공 분야 아나운서 | 대학교 행사·입학식·졸업식 전문",
    bio: "교육부 공모 아나운서 출신. 대학교 졸업식, 입학식, 학술대회, 교육기관 공식 행사를 주로 진행합니다. 학생들과의 친근한 소통과 교수진에 대한 예의 있는 의전을 동시에 갖추고 있습니다.",
    region: "서울",
    availableRegions: ["서울", "경기", "인천", "충청"],
    categories: ["아나운서", "공공기관 행사", "교육 행사"],
    styles: ["정직한", "단정한", "신뢰감 있는"],
    careerYears: 6,
    priceMin: 500000,
    priceMax: 1100000,
    languages: ["한국어"],
    script: true,
    rehearsal: true,
    travel: true,
    avgRating: 4.8,
    reviewCount: 4,
    review: {
      bookingId: "seed_booking_han_seoyun_001",
      reviewId: "seed_review_han_seoyun_001",
      freelancerReviewId: "seed_freelancer_review_han_seoyun_001",
      eventTitle: "국립대학 입학식",
      eventDate: new Date("2026-05-07T00:00:00.000Z"),
      venue: "대학 본관 대강당",
      finalPrice: 800000,
      scores: [5, 5, 5, 4, 5, 4, 5],
      totalScore: 4.8,
      comment:
        "격식과 따뜻함의 균형이 좋았습니다. 교수진 의전과 학생 대상 안내 멘트 모두 안정적이었습니다.",
    },
  },
  {
    email: "wedding.lee@voit.co.kr",
    name: "이소은",
    phone: "010-2503-1212",
    profileId: "seed_profile_lee_soeun",
    displayName: "웨딩 MC 이소은",
    image: "/seed-profiles/lee-soeun.svg",
    headline: "감동의 웨딩 사회자 | 연간 200쌍의 행복을 함께했습니다",
    bio: "12년간 웨딩 사회자로 활동하며 연간 200건 이상의 결혼식을 진행했습니다. 신랑신부의 이야기를 담은 감동적인 스크립트와 자연스러운 진행으로 하객의 몰입도를 높입니다.",
    region: "서울",
    availableRegions: ["서울", "경기", "인천", "부산"],
    categories: ["웨딩 사회자", "아나운서", "개인 행사"],
    styles: ["감성적", "따뜻한", "차분한"],
    careerYears: 12,
    priceMin: 700000,
    priceMax: 1600000,
    languages: ["한국어"],
    script: true,
    rehearsal: true,
    travel: true,
    avgRating: 4.9,
    reviewCount: 4,
    review: {
      bookingId: "seed_booking_lee_soeun_001",
      reviewId: "seed_review_lee_soeun_001",
      freelancerReviewId: "seed_freelancer_review_lee_soeun_001",
      eventTitle: "프리미엄 호텔 웨딩 본식",
      eventDate: new Date("2026-06-08T00:00:00.000Z"),
      venue: "서울 웨딩홀 그랜드볼룸",
      finalPrice: 1150000,
      scores: [5, 5, 5, 5, 5, 5, 5],
      totalScore: 4.9,
      comment:
        "사전 인터뷰를 바탕으로 멘트를 정말 섬세하게 준비해주셨고, 현장 분위기를 따뜻하게 만들어주셨습니다.",
    },
  },
  {
    email: "mc.cho@voit.co.kr",
    name: "조혜진",
    phone: "010-2604-1209",
    profileId: "seed_profile_cho_hyejin",
    displayName: "MC 조혜진",
    image: "/seed-profiles/cho-hyejin.svg",
    headline: "정부·공공기관 행사 전문 MC | 청와대·부처 행사 진행 경험",
    bio: "12년간 정부 부처, 공공기관, 지방자치단체 행사를 전담해온 MC. 국가 공식 행사의 엄격한 의전 기준을 이해하고 준수합니다. 장관급 이상 귀빈 행사 진행 경험이 다수 있습니다.",
    region: "서울",
    availableRegions: ["서울", "세종", "대전", "전국"],
    categories: ["컨퍼런스 MC", "기업행사 MC", "공공기관 행사"],
    styles: ["격식있는", "신뢰감있는", "올곧은"],
    careerYears: 12,
    priceMin: 900000,
    priceMax: 2200000,
    languages: ["한국어", "영어"],
    script: true,
    rehearsal: true,
    travel: true,
    avgRating: 4.9,
    reviewCount: 4,
    review: {
      bookingId: "seed_booking_cho_hyejin_001",
      reviewId: "seed_review_cho_hyejin_001",
      freelancerReviewId: "seed_freelancer_review_cho_hyejin_001",
      eventTitle: "정부부처 정책포럼",
      eventDate: new Date("2026-03-09T00:00:00.000Z"),
      venue: "정부세종컨벤션센터",
      finalPrice: 1550000,
      scores: [5, 5, 5, 5, 5, 5, 5],
      totalScore: 4.9,
      comment:
        "귀빈 의전과 순서 전환이 매우 안정적이었습니다. 공공기관 행사에 필요한 품격을 잘 살려주셨습니다.",
    },
  },
  {
    email: "host.sujin@voit.co.kr",
    name: "이수진",
    phone: "010-2705-0808",
    profileId: "seed_profile_lee_sujin",
    displayName: "쇼호스트 이수진",
    image: "/seed-profiles/lee-sujin.svg",
    headline: "라이브커머스 전문 쇼호스트 | 제품 설명·실시간 소통 강점",
    bio: "홈쇼핑과 라이브커머스 현장을 모두 경험한 쇼호스트입니다. 상품 USP를 빠르게 파악하고, 댓글 반응에 맞춘 순발력 있는 판매 멘트와 브랜드 톤 유지에 강합니다.",
    region: "서울",
    availableRegions: ["서울", "경기", "전국"],
    categories: ["쇼호스트", "라이브커머스", "브랜드 콘텐츠"],
    styles: ["활기찬", "친근한", "판매 중심"],
    careerYears: 6,
    priceMin: 500000,
    priceMax: 1400000,
    languages: ["한국어"],
    script: true,
    rehearsal: true,
    travel: true,
    avgRating: 4.8,
    reviewCount: 3,
    review: {
      bookingId: "seed_booking_lee_sujin_001",
      reviewId: "seed_review_lee_sujin_001",
      freelancerReviewId: "seed_freelancer_review_lee_sujin_001",
      eventTitle: "뷰티 브랜드 쇼핑라이브",
      eventDate: new Date("2026-04-10T00:00:00.000Z"),
      venue: "성수동 라이브 스튜디오",
      finalPrice: 950000,
      scores: [5, 5, 5, 4, 5, 4, 5],
      totalScore: 4.8,
      comment:
        "제품 포인트를 빠르게 이해하고 실시간 반응을 잘 살려주었습니다. 브랜드 톤도 안정적으로 유지했습니다.",
    },
  },
  {
    email: "mc.park@voit.co.kr",
    name: "박진행",
    phone: "010-2806-5432",
    profileId: "seed_profile_park_jinhaeng",
    displayName: "MC 박진행",
    image: "/seed-profiles/park-jinhaeng.svg",
    headline: "10년 경력의 전문 MC | 기업행사·컨퍼런스 전문",
    bio: "대기업 임직원 행사, 컨퍼런스, 시상식 진행 경험이 풍부합니다. 청중과 소통하면서도 공식 행사의 품격을 유지하는 진행 스타일이 강점입니다.",
    region: "서울",
    availableRegions: ["서울", "경기", "인천", "부산"],
    categories: ["기업행사 MC", "컨퍼런스 MC", "시상식"],
    styles: ["정중한", "전문적", "안정적인"],
    careerYears: 10,
    priceMin: 700000,
    priceMax: 1800000,
    languages: ["한국어", "영어"],
    script: true,
    rehearsal: true,
    travel: true,
    avgRating: 4.8,
    reviewCount: 2,
    review: {
      bookingId: "seed_booking_park_jinhaeng_001",
      reviewId: "seed_review_park_jinhaeng_001",
      freelancerReviewId: "seed_freelancer_review_park_jinhaeng_001",
      eventTitle: "하반기 임직원 포상 시상식",
      eventDate: new Date("2026-05-11T00:00:00.000Z"),
      venue: "코엑스 컨퍼런스룸",
      finalPrice: 1250000,
      scores: [5, 5, 5, 4, 5, 4, 5],
      totalScore: 4.8,
      comment:
        "큰 행사였는데도 흐름을 놓치지 않고 안정적으로 이끌어주셨습니다. 임원진 소개와 수상자 호명도 정확했습니다.",
    },
  },
  {
    email: "announcer.kim@voit.co.kr",
    name: "김도훈",
    phone: "010-2907-3401",
    profileId: "seed_profile_kim_dohun",
    displayName: "아나운서 김도훈",
    image: "/seed-profiles/kim-dohun.svg",
    headline: "브랜드 영상·인터뷰 진행자 | 부드러운 전달력과 신뢰감",
    bio: "기업 브랜드 영상, 인터뷰 콘텐츠, 사내 방송을 주로 진행합니다. 차분하면서도 친근한 인상과 정확한 딕션으로 카메라 앞 진행에 강합니다.",
    region: "서울",
    availableRegions: ["서울", "경기", "인천"],
    categories: ["아나운서", "브랜드 콘텐츠", "인터뷰 진행"],
    styles: ["부드러운", "신뢰감 있는", "차분한"],
    careerYears: 5,
    priceMin: 450000,
    priceMax: 1000000,
    languages: ["한국어"],
    script: true,
    rehearsal: false,
    travel: true,
    avgRating: 4.6,
    reviewCount: 2,
    review: {
      bookingId: "seed_booking_kim_dohun_001",
      reviewId: "seed_review_kim_dohun_001",
      freelancerReviewId: "seed_freelancer_review_kim_dohun_001",
      eventTitle: "스타트업 브랜드 인터뷰 영상",
      eventDate: new Date("2026-06-12T00:00:00.000Z"),
      venue: "합정 콘텐츠 스튜디오",
      finalPrice: 725000,
      scores: [5, 4, 5, 4, 4, 5, 5],
      totalScore: 4.6,
      comment:
        "카메라 앞에서 자연스럽고 질문 흐름을 잘 잡아주었습니다. 인터뷰이가 편하게 말할 수 있도록 분위기를 만들어주셨습니다.",
    },
  },
  {
    email: "global.yuna@voit.co.kr",
    name: "정유나",
    phone: "010-3008-7701",
    profileId: "seed_profile_jung_yuna",
    displayName: "글로벌 MC 정유나",
    image: "/seed-profiles/jung-yuna.svg",
    headline: "영어 MC·국제행사 진행 | 글로벌 컨퍼런스 전문",
    bio: "국제 포럼, 외국계 기업 세미나, 관광·MICE 행사에서 영어와 한국어를 모두 사용하는 이중언어 진행자입니다. 순차통역 흐름과 해외 연사 의전을 이해합니다.",
    region: "서울",
    availableRegions: ["서울", "부산", "제주", "전국"],
    categories: ["영어 MC", "컨퍼런스 MC", "국제행사"],
    styles: ["격식있는", "유연한", "글로벌"],
    careerYears: 8,
    priceMin: 900000,
    priceMax: 2500000,
    languages: ["한국어", "영어"],
    script: true,
    rehearsal: true,
    travel: true,
    avgRating: 4.9,
    reviewCount: 2,
    review: {
      bookingId: "seed_booking_jung_yuna_001",
      reviewId: "seed_review_jung_yuna_001",
      freelancerReviewId: "seed_freelancer_review_jung_yuna_001",
      eventTitle: "글로벌 관광 컨퍼런스",
      eventDate: new Date("2026-03-13T00:00:00.000Z"),
      venue: "부산 BEXCO",
      finalPrice: 1700000,
      scores: [5, 5, 5, 5, 5, 5, 5],
      totalScore: 4.9,
      comment:
        "영어 진행과 한국어 전환 모두 자연스러웠고, 해외 연사 소개도 품격 있게 진행해주셨습니다.",
    },
  },
  {
    email: "festival.minjae@voit.co.kr",
    name: "최민재",
    phone: "010-3109-4420",
    profileId: "seed_profile_choi_minjae",
    displayName: "축제 MC 최민재",
    image: "/seed-profiles/choi-minjae.svg",
    headline: "지역축제·관객 참여형 행사 MC | 현장 분위기 메이커",
    bio: "지역축제, 대학 행사, 레크리에이션, 공개방송형 무대에 강한 진행자입니다. 관객 참여를 자연스럽게 유도하고 돌발상황에도 밝게 대응합니다.",
    region: "부산",
    availableRegions: ["부산", "경남", "대구", "전국"],
    categories: ["행사 MC", "지역축제", "관객 참여형 행사"],
    styles: ["밝고 활기찬", "유머 있는", "관객 참여형"],
    careerYears: 9,
    priceMin: 500000,
    priceMax: 1300000,
    languages: ["한국어"],
    script: false,
    rehearsal: true,
    travel: true,
    avgRating: 4.7,
    reviewCount: 2,
    review: {
      bookingId: "seed_booking_choi_minjae_001",
      reviewId: "seed_review_choi_minjae_001",
      freelancerReviewId: "seed_freelancer_review_choi_minjae_001",
      eventTitle: "부산 지역문화축제",
      eventDate: new Date("2026-04-14T00:00:00.000Z"),
      venue: "부산 시민공원 야외무대",
      finalPrice: 900000,
      scores: [5, 4, 5, 4, 4, 5, 5],
      totalScore: 4.7,
      comment:
        "관객 반응을 잘 끌어내고 무대 전환도 밝게 이어주셨습니다. 현장 에너지가 확실히 살아났습니다.",
    },
  },
  {
    email: "moderator.seo@voit.co.kr",
    name: "서민지",
    phone: "010-3201-9123",
    profileId: "seed_profile_seo_minji",
    displayName: "모더레이터 서민지",
    image: "/seed-profiles/seo-minji.svg",
    headline: "포럼·패널토론 전문 모더레이터 | 질문 설계와 시간 관리 강점",
    bio: "정책 포럼과 산업 세미나에서 패널토론을 다수 진행했습니다. 사전 자료를 읽고 핵심 질문을 설계하며, 발언 균형과 시간 관리를 안정적으로 이끕니다.",
    region: "서울",
    availableRegions: ["서울", "경기", "세종", "전국"],
    categories: ["모더레이터", "포럼", "컨퍼런스 MC"],
    styles: ["지적인", "차분한", "균형감 있는"],
    careerYears: 9,
    priceMin: 800000,
    priceMax: 2000000,
    languages: ["한국어", "영어"],
    script: true,
    rehearsal: true,
    travel: true,
    avgRating: 4.9,
    reviewCount: 2,
    review: {
      bookingId: "seed_booking_seo_minji_001",
      reviewId: "seed_review_seo_minji_001",
      freelancerReviewId: "seed_freelancer_review_seo_minji_001",
      eventTitle: "AI 산업전략 패널토론",
      eventDate: new Date("2026-05-15T00:00:00.000Z"),
      venue: "대한상공회의소",
      finalPrice: 1400000,
      scores: [5, 5, 5, 5, 5, 5, 5],
      totalScore: 4.9,
      comment:
        "패널별 발언 균형을 잘 잡아주고 질문의 깊이가 좋았습니다. 예정 시간을 정확히 맞춘 점도 인상적이었습니다.",
    },
  },
  {
    email: "mc.oh@voit.co.kr",
    name: "오지환",
    phone: "010-3302-4567",
    profileId: "seed_profile_oh_jihwan",
    displayName: "MC 오지환",
    image: "/seed-profiles/oh-jihwan.svg",
    headline: "기업 워크숍·레크리에이션 MC | 밝은 에너지와 참여 유도",
    bio: "기업 워크숍, 사내 체육대회, 팀빌딩 행사에 강한 MC입니다. 어색한 분위기를 빠르게 풀고 참여형 프로그램을 자연스럽게 연결합니다.",
    region: "대전",
    availableRegions: ["대전", "충청", "세종", "전국"],
    categories: ["행사 MC", "기업 워크숍", "레크리에이션"],
    styles: ["유쾌한", "활기찬", "친근한"],
    careerYears: 8,
    priceMin: 500000,
    priceMax: 1200000,
    languages: ["한국어"],
    script: false,
    rehearsal: true,
    travel: true,
    avgRating: 4.6,
    reviewCount: 2,
    review: {
      bookingId: "seed_booking_oh_jihwan_001",
      reviewId: "seed_review_oh_jihwan_001",
      freelancerReviewId: "seed_freelancer_review_oh_jihwan_001",
      eventTitle: "IT기업 전사 워크숍",
      eventDate: new Date("2026-06-16T00:00:00.000Z"),
      venue: "대전 컨벤션센터",
      finalPrice: 850000,
      scores: [5, 4, 5, 4, 4, 5, 5],
      totalScore: 4.6,
      comment:
        "참여율이 낮을까 걱정했는데 분위기를 정말 잘 열어주셨습니다. 진행이 과하지 않고 유쾌했습니다.",
    },
  },
  {
    email: "commerce.bae@voit.co.kr",
    name: "배연우",
    phone: "010-3403-1188",
    profileId: "seed_profile_bae_yeonwoo",
    displayName: "쇼호스트 배연우",
    image: "/seed-profiles/bae-yeonwoo.svg",
    headline: "식품·리빙 라이브커머스 쇼호스트 | 구매전환형 멘트 전문",
    bio: "식품, 리빙, 생활가전 라이브커머스를 주로 진행합니다. 제품 사용 장면을 쉽게 설명하고, 혜택 고지와 구매 유도 멘트를 자연스럽게 연결합니다.",
    region: "경기",
    availableRegions: ["서울", "경기", "인천"],
    categories: ["쇼호스트", "라이브커머스", "제품 발표"],
    styles: ["친근한", "설득력 있는", "판매 중심"],
    careerYears: 7,
    priceMin: 550000,
    priceMax: 1500000,
    languages: ["한국어"],
    script: true,
    rehearsal: true,
    travel: true,
    avgRating: 4.8,
    reviewCount: 2,
    review: {
      bookingId: "seed_booking_bae_yeonwoo_001",
      reviewId: "seed_review_bae_yeonwoo_001",
      freelancerReviewId: "seed_freelancer_review_bae_yeonwoo_001",
      eventTitle: "리빙 브랜드 신제품 라이브",
      eventDate: new Date("2026-03-17T00:00:00.000Z"),
      venue: "판교 라이브 스튜디오",
      finalPrice: 1025000,
      scores: [5, 5, 5, 4, 5, 4, 5],
      totalScore: 4.8,
      comment:
        "상품 설명이 쉽고 명확했습니다. 실시간 질문 대응도 빨라 구매 전환에 도움이 되었습니다.",
    },
  },
  {
    email: "announcer.kang@voit.co.kr",
    name: "강하린",
    phone: "010-3504-6677",
    profileId: "seed_profile_kang_harin",
    displayName: "아나운서 강하린",
    image: "/seed-profiles/kang-harin.svg",
    headline: "시상식·개소식 아나운서 | 단정한 발성과 정확한 식순 진행",
    bio: "개소식, 기념식, 시상식처럼 식순 정확도가 중요한 행사를 안정적으로 진행합니다. 발음과 호흡이 또렷하고, 격식 있는 분위기에 잘 맞습니다.",
    region: "대구",
    availableRegions: ["대구", "경북", "부산", "전국"],
    categories: ["아나운서", "시상식", "공식 행사"],
    styles: ["단정한", "정확한", "격식있는"],
    careerYears: 6,
    priceMin: 450000,
    priceMax: 1000000,
    languages: ["한국어"],
    script: true,
    rehearsal: true,
    travel: true,
    avgRating: 4.7,
    reviewCount: 2,
    review: {
      bookingId: "seed_booking_kang_harin_001",
      reviewId: "seed_review_kang_harin_001",
      freelancerReviewId: "seed_freelancer_review_kang_harin_001",
      eventTitle: "공공기관 개소식",
      eventDate: new Date("2026-04-18T00:00:00.000Z"),
      venue: "대구 혁신도시",
      finalPrice: 725000,
      scores: [5, 4, 5, 4, 4, 5, 5],
      totalScore: 4.7,
      comment:
        "식순 진행이 매우 정확했고, 현장 변경 사항도 차분하게 반영해주었습니다.",
    },
  },
  {
    email: "english.lim@voit.co.kr",
    name: "임태호",
    phone: "010-3605-9988",
    profileId: "seed_profile_lim_taeho",
    displayName: "영어 MC 임태호",
    image: "/seed-profiles/lim-taeho.svg",
    headline: "국제회의·외국계 기업 행사 영어 MC | 품격 있는 이중언어 진행",
    bio: "외국계 기업 타운홀, 국제회의, 글로벌 파트너 행사 진행 경험이 많습니다. 영어 오프닝, 연사 소개, Q&A 전환까지 자연스럽게 진행합니다.",
    region: "서울",
    availableRegions: ["서울", "경기", "제주", "전국"],
    categories: ["영어 MC", "국제행사", "기업행사 MC"],
    styles: ["프로페셔널", "격식있는", "글로벌"],
    careerYears: 11,
    priceMin: 1000000,
    priceMax: 2700000,
    languages: ["한국어", "영어"],
    script: true,
    rehearsal: true,
    travel: true,
    avgRating: 4.9,
    reviewCount: 2,
    review: {
      bookingId: "seed_booking_lim_taeho_001",
      reviewId: "seed_review_lim_taeho_001",
      freelancerReviewId: "seed_freelancer_review_lim_taeho_001",
      eventTitle: "글로벌 파트너 서밋",
      eventDate: new Date("2026-05-19T00:00:00.000Z"),
      venue: "그랜드 하얏트 서울",
      finalPrice: 1850000,
      scores: [5, 5, 5, 5, 5, 5, 5],
      totalScore: 4.9,
      comment:
        "해외 임원진 소개와 Q&A 전환이 자연스러웠습니다. 영어 진행의 품격이 좋았습니다.",
    },
  },
  {
    email: "wedding.yoon@voit.co.kr",
    name: "윤다솜",
    phone: "010-3706-2211",
    profileId: "seed_profile_yoon_dasom",
    displayName: "웨딩 MC 윤다솜",
    image: "/seed-profiles/yoon-dasom.svg",
    headline: "밝고 따뜻한 웨딩 사회자 | 소규모·하우스웨딩 전문",
    bio: "소규모 웨딩과 하우스웨딩에서 자연스럽고 따뜻한 분위기를 만드는 진행자입니다. 신랑신부 맞춤 멘트와 하객 참여형 순서를 부드럽게 연결합니다.",
    region: "인천",
    availableRegions: ["서울", "인천", "경기"],
    categories: ["웨딩 사회자", "개인 행사", "하우스웨딩"],
    styles: ["따뜻한", "밝은", "자연스러운"],
    careerYears: 5,
    priceMin: 400000,
    priceMax: 900000,
    languages: ["한국어"],
    script: true,
    rehearsal: false,
    travel: true,
    avgRating: 4.6,
    reviewCount: 2,
    review: {
      bookingId: "seed_booking_yoon_dasom_001",
      reviewId: "seed_review_yoon_dasom_001",
      freelancerReviewId: "seed_freelancer_review_yoon_dasom_001",
      eventTitle: "하우스웨딩 본식",
      eventDate: new Date("2026-06-20T00:00:00.000Z"),
      venue: "인천 프라이빗 웨딩홀",
      finalPrice: 650000,
      scores: [5, 4, 5, 4, 4, 5, 5],
      totalScore: 4.6,
      comment:
        "과하지 않고 따뜻한 진행이 정말 좋았습니다. 하객들도 편안하게 느꼈다고 이야기해주었습니다.",
    },
  },
  {
    email: "sports.moon@voit.co.kr",
    name: "문승재",
    phone: "010-3807-3456",
    profileId: "seed_profile_moon_seungjae",
    displayName: "스포츠 MC 문승재",
    image: "/seed-profiles/moon-seungjae.svg",
    headline: "스포츠·야외 행사 MC | 에너지 있는 현장 진행",
    bio: "스포츠 대회, 야외 페스티벌, 팬 이벤트 진행 경험이 많습니다. 넓은 현장에서 관객 집중도를 유지하고 돌발상황에 강하게 대응합니다.",
    region: "광주",
    availableRegions: ["광주", "전남", "전북", "전국"],
    categories: ["스포츠 행사", "야외 행사", "행사 MC"],
    styles: ["역동적인", "에너지 있는", "관객 참여형"],
    careerYears: 10,
    priceMin: 600000,
    priceMax: 1600000,
    languages: ["한국어"],
    script: false,
    rehearsal: true,
    travel: true,
    avgRating: 4.7,
    reviewCount: 2,
    review: {
      bookingId: "seed_booking_moon_seungjae_001",
      reviewId: "seed_review_moon_seungjae_001",
      freelancerReviewId: "seed_freelancer_review_moon_seungjae_001",
      eventTitle: "브랜드 러닝 페스티벌",
      eventDate: new Date("2026-03-21T00:00:00.000Z"),
      venue: "광주 월드컵경기장",
      finalPrice: 1100000,
      scores: [5, 4, 5, 4, 4, 5, 5],
      totalScore: 4.7,
      comment:
        "야외 행사 특유의 변수가 많았는데 에너지 있게 잘 이끌어주었습니다. 관객 반응도 좋았습니다.",
    },
  },
  {
    email: "narrator.nam@voit.co.kr",
    name: "남서희",
    phone: "010-3908-4567",
    profileId: "seed_profile_nam_seohee",
    displayName: "내레이터 남서희",
    image: "/seed-profiles/nam-seohee.svg",
    headline:
      "브랜드 영상 내레이션·행사 오프닝 보이스 | 맑고 신뢰감 있는 목소리",
    bio: "브랜드 영상, 기업 홍보영상, 행사 오프닝 내레이션을 주로 맡았습니다. 차분하고 맑은 음색으로 메시지를 또렷하게 전달합니다.",
    region: "서울",
    availableRegions: ["서울", "경기", "비대면"],
    categories: ["내레이터", "브랜드 콘텐츠", "아나운서"],
    styles: ["차분한", "맑은", "신뢰감 있는"],
    careerYears: 7,
    priceMin: 350000,
    priceMax: 900000,
    languages: ["한국어"],
    script: true,
    rehearsal: false,
    travel: false,
    avgRating: 4.8,
    reviewCount: 2,
    review: {
      bookingId: "seed_booking_nam_seohee_001",
      reviewId: "seed_review_nam_seohee_001",
      freelancerReviewId: "seed_freelancer_review_nam_seohee_001",
      eventTitle: "기업 브랜드 필름 내레이션",
      eventDate: new Date("2026-04-22T00:00:00.000Z"),
      venue: "강남 녹음 스튜디오",
      finalPrice: 625000,
      scores: [5, 5, 5, 4, 5, 4, 5],
      totalScore: 4.8,
      comment:
        "브랜드가 원하는 차분한 톤을 정확히 구현해주었습니다. 수정 요청 반영도 빨랐습니다.",
    },
  },
  {
    email: "mc.ryu@voit.co.kr",
    name: "류현수",
    phone: "010-4009-7654",
    profileId: "seed_profile_ryu_hyunsu",
    displayName: "MC 류현수",
    image: "/seed-profiles/ryu-hyunsu.svg",
    headline: "제주 MICE·관광 행사 MC | 지역 행사와 컨벤션 모두 가능",
    bio: "제주 지역 MICE 행사, 관광 컨퍼런스, 리조트 기업행사를 다수 진행했습니다. 지역 동선과 야외 행사 변수에 익숙합니다.",
    region: "제주",
    availableRegions: ["제주", "전국"],
    categories: ["컨퍼런스 MC", "관광 행사", "기업행사 MC"],
    styles: ["안정적인", "밝은", "유연한"],
    careerYears: 9,
    priceMin: 700000,
    priceMax: 1800000,
    languages: ["한국어", "영어"],
    script: true,
    rehearsal: true,
    travel: true,
    avgRating: 4.7,
    reviewCount: 2,
    review: {
      bookingId: "seed_booking_ryu_hyunsu_001",
      reviewId: "seed_review_ryu_hyunsu_001",
      freelancerReviewId: "seed_freelancer_review_ryu_hyunsu_001",
      eventTitle: "제주 관광 MICE 설명회",
      eventDate: new Date("2026-05-23T00:00:00.000Z"),
      venue: "제주국제컨벤션센터",
      finalPrice: 1250000,
      scores: [5, 4, 5, 4, 4, 5, 5],
      totalScore: 4.7,
      comment:
        "제주 현장 특성을 잘 이해하고 있었고, 행사 흐름을 안정적으로 이끌어주었습니다.",
    },
  },
  {
    email: "presenter.jang@voit.co.kr",
    name: "장혜미",
    phone: "010-4100-5533",
    profileId: "seed_profile_jang_hyemi",
    displayName: "프레젠터 장혜미",
    image: "/seed-profiles/jang-hyemi.svg",
    headline: "신제품 발표·브랜드 프레젠터 | 제품 이해와 전달력 강점",
    bio: "신제품 발표회, 브랜드 데모데이, 쇼케이스 진행에 강한 프레젠터입니다. 제품 기능과 고객 가치를 쉽게 풀어 설명합니다.",
    region: "서울",
    availableRegions: ["서울", "경기", "인천"],
    categories: ["프레젠터", "제품 발표", "브랜드 콘텐츠"],
    styles: ["세련된", "명확한", "설득력 있는"],
    careerYears: 6,
    priceMin: 600000,
    priceMax: 1500000,
    languages: ["한국어", "영어"],
    script: true,
    rehearsal: true,
    travel: true,
    avgRating: 4.8,
    reviewCount: 2,
    review: {
      bookingId: "seed_booking_jang_hyemi_001",
      reviewId: "seed_review_jang_hyemi_001",
      freelancerReviewId: "seed_freelancer_review_jang_hyemi_001",
      eventTitle: "테크 신제품 쇼케이스",
      eventDate: new Date("2026-06-24T00:00:00.000Z"),
      venue: "성수 브랜드 팝업홀",
      finalPrice: 1050000,
      scores: [5, 5, 5, 4, 5, 4, 5],
      totalScore: 4.8,
      comment:
        "복잡한 제품 기능을 이해하기 쉽게 설명해주었습니다. 발표 흐름이 세련되고 깔끔했습니다.",
    },
  },
];

async function cleanupPreviousSeedData() {
  console.log("🧹 이전 seed 데이터 정리 중(seed_ 접두사만 삭제)...");
  await prisma.chatMessage.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "seed_" } },
        { room_id: { startsWith: "seed_" } },
        { sender_id: { startsWith: "seed_" } },
      ],
    },
  });
  await prisma.bookingOffer.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "seed_" } },
        { booking_id: { startsWith: "seed_" } },
        { sender_id: { startsWith: "seed_" } },
        { receiver_id: { startsWith: "seed_" } },
      ],
    },
  });
  await prisma.chatRoom.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "seed_" } },
        { booking_id: { startsWith: "seed_" } },
        { customer_id: { startsWith: "seed_" } },
        { freelancer_id: { startsWith: "seed_" } },
      ],
    },
  });
  await prisma.notification.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "seed_" } },
        { user_id: { startsWith: "seed_" } },
      ],
    },
  });
  await prisma.savedFreelancer.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "seed_" } },
        { customer_id: { startsWith: "seed_" } },
        { freelancer_id: { startsWith: "seed_" } },
      ],
    },
  });
  await prisma.freelancerReview.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "seed_" } },
        { booking_id: { startsWith: "seed_" } },
        { customer_id: { startsWith: "seed_" } },
        { freelancer_id: { startsWith: "seed_" } },
      ],
    },
  });
  await prisma.review.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "seed_" } },
        { booking_id: { startsWith: "seed_" } },
        { customer_id: { startsWith: "seed_" } },
        { freelancer_id: { startsWith: "seed_" } },
      ],
    },
  });
  await prisma.contract.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "seed_" } },
        { booking_id: { startsWith: "seed_" } },
      ],
    },
  });
  await prisma.payment.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "seed_" } },
        { booking_id: { startsWith: "seed_" } },
      ],
    },
  });
  await prisma.booking.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "seed_" } },
        { customer_id: { startsWith: "seed_" } },
        { freelancer_id: { startsWith: "seed_" } },
      ],
    },
  });
  await prisma.quote.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "seed_" } },
        { request_id: { startsWith: "seed_" } },
        { freelancer_id: { startsWith: "seed_" } },
        { quoted_by: { startsWith: "seed_" } },
      ],
    },
  });
  await prisma.recommendation.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "seed_" } },
        { request_id: { startsWith: "seed_" } },
        { freelancer_id: { startsWith: "seed_" } },
        { recommended_by: { startsWith: "seed_" } },
      ],
    },
  });
  await prisma.eventRequest.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "seed_" } },
        { customer_id: { startsWith: "seed_" } },
      ],
    },
  });
  await prisma.portfolio.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "seed_" } },
        { freelancer_id: { startsWith: "seed_" } },
      ],
    },
  });
  await prisma.freelancerProfile.deleteMany({
    where: { id: { startsWith: "seed_" } },
  });
  await prisma.customerProfile.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "seed_" } },
        { user_id: { startsWith: "seed_" } },
      ],
    },
  });
  await prisma.refreshToken.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "seed_" } },
        { user_id: { startsWith: "seed_" } },
      ],
    },
  });
  await prisma.user.deleteMany({ where: { id: { startsWith: "seed_" } } });
}

async function upsertUser(input: {
  id: string;
  email: string;
  name: string;
  phone: string;
  userType: UserType;
  passwordHash: string;
}) {
  return prisma.user.upsert({
    where: { email: input.email },
    update: {
      name: input.name,
      phone: input.phone,
      user_type: input.userType,
      password_hash: input.passwordHash,
      is_active: true,
      provider: null,
      provider_id: null,
    },
    create: {
      id: input.id,
      email: input.email,
      name: input.name,
      phone: input.phone,
      user_type: input.userType,
      password_hash: input.passwordHash,
      is_active: true,
    },
  });
}

async function seedUsers() {
  const adminHash = await bcrypt.hash(
    process.env.ADMIN_PASSWORD || PASSWORDS.admin,
    12,
  );
  const customerHash = await bcrypt.hash(PASSWORDS.customer, 12);

  const admin = await upsertUser({
    id: "seed_user_admin",
    email: process.env.ADMIN_EMAIL || "admin@voit.co.kr",
    name: "보잇 관리자",
    phone: "010-0000-0000",
    userType: UserType.admin,
    passwordHash: adminHash,
  });

  const customer = await upsertUser({
    id: "seed_user_customer_employer",
    email: "employer@voit.co.kr",
    name: "윤고용",
    phone: "010-1234-5678",
    userType: UserType.customer,
    passwordHash: customerHash,
  });

  await prisma.customerProfile.upsert({
    where: { user_id: customer.id },
    update: {
      customer_type: "company",
      company_name: "주식회사 보이스브릿지",
      department: "행사기획팀",
      manager_name: "윤고용",
      memo: "보잇 시연용 고용인 계정. 기업 행사, 공공 포럼, 브랜드 콘텐츠 진행자 섭외를 담당합니다.",
    },
    create: {
      id: "seed_customer_profile_employer",
      user_id: customer.id,
      customer_type: "company",
      company_name: "주식회사 보이스브릿지",
      department: "행사기획팀",
      manager_name: "윤고용",
      memo: "보잇 시연용 고용인 계정. 기업 행사, 공공 포럼, 브랜드 콘텐츠 진행자 섭외를 담당합니다.",
    },
  });

  return { admin, customer, customerHash };
}

async function seedFreelancer(f: FreelancerSeed, passwordHash: string) {
  const user = await upsertUser({
    id: `seed_user_${f.profileId.replace("seed_profile_", "")}`,
    email: f.email,
    name: f.name,
    phone: f.phone,
    userType: UserType.freelancer,
    passwordHash,
  });

  const profile = await prisma.freelancerProfile.upsert({
    where: { user_id: user.id },
    update: {
      display_name: f.displayName,
      profile_image_url: f.image,
      profile_image_path: null,
      headline: f.headline,
      bio: f.bio,
      region: f.region,
      available_regions: f.availableRegions,
      categories: f.categories,
      styles: f.styles,
      career_years: f.careerYears,
      base_price_min: f.priceMin,
      base_price_max: f.priceMax,
      languages: f.languages,
      script_writing_available: f.script,
      rehearsal_available: f.rehearsal,
      travel_available: f.travel,
      status: FreelancerStatus.approved,
      approved_at: new Date(),
      rejected_reason: null,
      avg_rating: f.avgRating,
      review_count: f.reviewCount,
    },
    create: {
      id: f.profileId,
      user_id: user.id,
      display_name: f.displayName,
      profile_image_url: f.image,
      headline: f.headline,
      bio: f.bio,
      region: f.region,
      available_regions: f.availableRegions,
      categories: f.categories,
      styles: f.styles,
      career_years: f.careerYears,
      base_price_min: f.priceMin,
      base_price_max: f.priceMax,
      languages: f.languages,
      script_writing_available: f.script,
      rehearsal_available: f.rehearsal,
      travel_available: f.travel,
      status: FreelancerStatus.approved,
      approved_at: new Date(),
      avg_rating: f.avgRating,
      review_count: f.reviewCount,
    },
  });

  return { user, profile };
}

function pad(num: number) {
  return String(num).padStart(3, "0");
}

function getSeedSlug(f: FreelancerSeed) {
  return f.profileId.replace("seed_profile_", "");
}

function makeScoreSet(
  target: number,
  index: number,
): [number, number, number, number, number, number, number] {
  if (target >= 4.85) {
    const sets: [number, number, number, number, number, number, number][] = [
      [5, 5, 5, 5, 5, 5, 5],
      [5, 5, 5, 5, 5, 4, 5],
      [5, 5, 5, 4, 5, 5, 5],
      [5, 5, 4, 5, 5, 5, 5],
    ];
    return sets[index % sets.length];
  }

  if (target >= 4.7) {
    const sets: [number, number, number, number, number, number, number][] = [
      [5, 5, 5, 4, 5, 4, 5],
      [5, 4, 5, 5, 4, 5, 5],
      [5, 5, 4, 5, 5, 4, 5],
      [4, 5, 5, 4, 5, 5, 5],
    ];
    return sets[index % sets.length];
  }

  const sets: [number, number, number, number, number, number, number][] = [
    [5, 4, 5, 4, 4, 5, 5],
    [4, 5, 5, 4, 4, 5, 5],
    [5, 4, 4, 5, 4, 5, 5],
    [4, 5, 4, 5, 4, 5, 5],
  ];
  return sets[index % sets.length];
}

function average(scores: number[]) {
  return (
    Math.round(
      (scores.reduce((sum, value) => sum + value, 0) / scores.length) * 10,
    ) / 10
  );
}

const EVENT_TITLE_VARIANTS = [
  "기업 브랜드 컨퍼런스",
  "공공기관 정책 포럼",
  "신제품 발표 쇼케이스",
  "스타트업 데모데이",
  "임직원 시상식",
  "지역 문화 행사",
  "프리미엄 웨딩 본식",
  "라이브커머스 특별 방송",
  "산업 세미나",
  "브랜드 인터뷰 콘텐츠",
  "대학 공식 행사",
  "파트너 네트워킹 데이",
];

const VENUE_VARIANTS = [
  "코엑스 컨퍼런스룸",
  "서울창업허브",
  "대한상공회의소",
  "성수 브랜드 스튜디오",
  "부산 BEXCO",
  "정부세종컨벤션센터",
  "판교 라이브 스튜디오",
  "호텔 그랜드볼룸",
  "대학 본관 대강당",
  "지역 문화예술회관",
  "제주국제컨벤션센터",
  "강남 컨퍼런스홀",
];

const REVIEW_CUSTOMERS: ReviewCustomerSeed[] = [
  { name: "김민지", companyName: "넥스트브릿지", department: "브랜드전략팀" },
  { name: "박서준", companyName: "라움컴퍼니", department: "행사기획팀" },
  { name: "이하늘", companyName: "모먼트랩", department: "콘텐츠마케팅팀" },
  { name: "최유진", companyName: "스테이지온", department: "MICE사업부" },
  { name: "정도윤", companyName: "그로스파트너스", department: "커뮤니케이션팀" },
  { name: "한지우", companyName: "웨이브커머스", department: "라이브커머스팀" },
  { name: "오세린", companyName: "블루픽쳐스", department: "제작운영팀" },
  { name: "윤태현", companyName: "아젠다포럼", department: "컨퍼런스운영팀" },
  { name: "강나래", companyName: "베뉴플러스", department: "웨딩사업부" },
  { name: "서지훈", companyName: "브랜드와이", department: "PR팀" },
  { name: "문채원", companyName: "서울에듀재단", department: "대외협력팀" },
  { name: "임수아", companyName: "포커스엠", department: "프로젝트운영팀" },
  { name: "노은서", companyName: "루미나스코리아", department: "마케팅팀" },
  { name: "장현우", companyName: "온더스테이지", department: "공연기획팀" },
  { name: "배지민", companyName: "하이브리드이벤트", department: "행사운영팀" },
  { name: "유다은", companyName: "브릿지컨설팅", department: "교육사업팀" },
  { name: "송민규", companyName: "핀포인트랩", department: "IR커뮤니케이션팀" },
  { name: "신예린", companyName: "메리앤코", department: "웨딩플래닝팀" },
  { name: "권도현", companyName: "어반커넥트", department: "파트너십팀" },
  { name: "홍서연", companyName: "클래스온", department: "세미나운영팀" },
  { name: "남지호", companyName: "엠플러스", department: "홍보팀" },
  { name: "차은별", companyName: "브랜드오브", department: "브랜드경험팀" },
  { name: "백승민", companyName: "코어이벤트", department: "제작관리팀" },
  { name: "전하린", companyName: "마이스링크", department: "국제회의팀" },
  { name: "안재윤", companyName: "오프닝랩", department: "프로그램팀" },
  { name: "고서희", companyName: "더세레모니", department: "웨딩운영팀" },
  { name: "하준영", companyName: "캠퍼스포럼", department: "대학행사팀" },
  { name: "류아인", companyName: "비욘드커머스", department: "라이브기획팀" },
  { name: "민채린", companyName: "브랜드무드", department: "콘텐츠팀" },
  { name: "주성민", companyName: "임팩트홀딩스", department: "사내문화팀" },
  { name: "양소율", companyName: "스피치앤무브", department: "교육운영팀" },
  { name: "허지안", companyName: "시티컨벤션", department: "행사섭외팀" },
  { name: "길도영", companyName: "퓨처데모", department: "스타트업지원팀" },
  { name: "원서진", companyName: "화이트데이즈", department: "웨딩콘텐츠팀" },
  { name: "표나윤", companyName: "아트앤피플", department: "문화사업팀" },
  { name: "석민호", companyName: "테크노트", department: "제품마케팅팀" },
  { name: "나유림", companyName: "글로벌MICE", department: "해외사업팀" },
  { name: "도윤서", companyName: "데일리브랜드", department: "캠페인팀" },
  { name: "마지훈", companyName: "그랜드베뉴", department: "VIP행사팀" },
  { name: "서하린", companyName: "플랜비웨딩", department: "본식운영팀" },
  { name: "이주원", companyName: "넥스트에듀", department: "입학행사팀" },
  { name: "박하경", companyName: "라이브픽", department: "스튜디오운영팀" },
  { name: "김태린", companyName: "파인포럼", department: "정책행사팀" },
  { name: "최시윤", companyName: "브랜드플로우", department: "론칭TF" },
  { name: "정예준", companyName: "인사이트파트너", department: "네트워킹팀" },
  { name: "한소미", companyName: "모던클래식", department: "의전운영팀" },
  { name: "오준서", companyName: "스케일업센터", department: "액셀러레이팅팀" },
  { name: "강예나", companyName: "커넥트홀", department: "고객경험팀" },
];

const REVIEW_OPENINGS = [
  "사전 미팅에서 행사 목적을 빠르게 이해해주셔서 준비 과정이 훨씬 수월했습니다.",
  "큐시트와 대본을 꼼꼼히 확인한 뒤 필요한 수정 포인트를 먼저 제안해주셨습니다.",
  "현장 도착부터 리허설까지 일정 관리가 정확해서 운영팀 입장에서 안심이 됐습니다.",
  "처음 상담 때부터 응답이 빠르고, 행사 성격에 맞는 톤을 구체적으로 잡아주셨습니다.",
  "자료 전달 후 이해 속도가 빨라 별도 설명을 많이 하지 않아도 진행 방향이 잘 맞았습니다.",
  "리허설에서 동선과 마이크 체크를 세심하게 봐주셔서 본 행사 완성도가 높아졌습니다.",
  "담당자, 음향팀, 현장 스태프와의 소통이 부드러워 전체 운영 흐름이 좋았습니다.",
  "행사 직전 변경사항이 있었는데도 침착하게 반영해주셔서 큰 도움이 됐습니다.",
];

const REVIEW_DETAILS = [
  "순서 전환 멘트가 자연스러웠고 참석자들이 집중력을 잃지 않도록 흐름을 잘 잡아주셨습니다.",
  "발성과 전달력이 좋아 넓은 공간에서도 안내 멘트가 또렷하게 들렸다는 피드백이 많았습니다.",
  "브랜드 메시지를 과하게 드러내지 않으면서도 핵심 키워드를 적절히 살려주셨습니다.",
  "귀빈 소개와 시상 순서처럼 실수가 나기 쉬운 구간도 차분하게 처리해주셨습니다.",
  "참석자 반응을 보면서 멘트 길이를 조절하는 감각이 좋아 현장 분위기가 자연스러웠습니다.",
  "예상보다 빠르게 진행된 구간에서는 애드리브로 시간을 안정적으로 맞춰주셨습니다.",
  "대본 숙지도가 높아 프롬프터에만 의존하지 않고 시선 처리까지 안정적이었습니다.",
  "행사 콘셉트와 관객층에 맞춰 너무 딱딱하지도 가볍지도 않은 톤을 유지해주셨습니다.",
];

const REVIEW_CLOSINGS = [
  "다음에도 비슷한 행사가 있으면 우선적으로 다시 문의드리고 싶습니다.",
  "내부 만족도도 높아서 행사 후 담당자 회의에서 좋은 평가를 받았습니다.",
  "가격 대비 만족도가 높고, 준비 과정까지 포함해 전반적으로 추천할 만합니다.",
  "현장 변수 대응까지 믿고 맡길 수 있는 진행자라는 인상을 받았습니다.",
  "참석자 피드백이 좋아서 같은 포맷의 다음 행사에도 잘 맞을 것 같습니다.",
  "준비부터 마무리까지 책임감 있게 챙겨주셔서 만족스러웠습니다.",
];

const CATEGORY_REVIEW_DETAILS: Record<string, string[]> = {
  "웨딩 사회자": [
    "신랑신부 인터뷰 내용을 과하지 않게 녹여주셔서 본식 분위기가 따뜻했습니다.",
    "양가 부모님 소개와 축사 전환이 정중했고, 하객 안내도 매끄러웠습니다.",
  ],
  "쇼호스트": [
    "제품 USP를 빠르게 파악하고 댓글 반응에 맞춘 멘트 전환이 좋았습니다.",
    "판매 포인트를 자연스럽게 반복해주셔서 방송 흐름과 전환율 모두 만족스러웠습니다.",
  ],
  "라이브커머스": [
    "실시간 채팅 흐름을 놓치지 않고 구매 포인트로 자연스럽게 연결해주셨습니다.",
    "상품 설명과 이벤트 안내가 명확해 방송 운영팀이 편하게 진행할 수 있었습니다.",
  ],
  "공공기관 행사": [
    "의전 기준을 잘 이해하고 있어 귀빈 소개와 공식 멘트가 안정적이었습니다.",
    "격식 있는 자리였는데도 분위기가 과하게 무겁지 않도록 균형을 잘 잡아주셨습니다.",
  ],
  "컨퍼런스 MC": [
    "세션 사이 전환과 발표자 소개가 정확해서 전체 프로그램 흐름이 깔끔했습니다.",
    "패널토론 전후로 핵심 메시지를 정리해주는 멘트가 특히 좋았습니다.",
  ],
  "기업행사 MC": [
    "임직원 대상 행사에 맞게 친근함과 공식적인 톤의 균형을 잘 맞춰주셨습니다.",
    "시상식과 네트워킹 순서 사이 분위기 전환을 안정적으로 이끌어주셨습니다.",
  ],
  "아나운서": [
    "딕션이 명확하고 문장 호흡이 좋아 공식 안내 멘트의 신뢰감이 높았습니다.",
    "카메라 앞 진행에서도 시선과 톤이 자연스러워 결과물 완성도가 좋았습니다.",
  ],
};

const FREELANCER_REVIEW_OPENINGS = [
  "요청사항이 명확했고 자료 전달이 빨라 준비가 수월했습니다.",
  "담당자 피드백이 구체적이라 행사 톤을 잡기 쉬웠습니다.",
  "리허설 시간이 충분히 확보되어 현장 변수를 미리 줄일 수 있었습니다.",
  "정산 조건과 일정 안내가 명확해서 안심하고 진행할 수 있었습니다.",
  "현장 스태프와 담당자의 커뮤니케이션이 좋아 진행 흐름이 매끄러웠습니다.",
];

const FREELANCER_REVIEW_CLOSINGS = [
  "다시 함께하고 싶은 고객입니다.",
  "다음 프로젝트에서도 좋은 결과를 만들 수 있을 것 같습니다.",
  "전반적으로 신뢰감 있게 협업할 수 있었습니다.",
  "준비 과정부터 행사 종료까지 좋은 협업이었습니다.",
  "일정과 역할 분담이 분명해 만족스러운 프로젝트였습니다.",
];

function stableIndex(seed: string, modulo: number): number {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) % 2147483647;
  }
  return Math.abs(hash) % modulo;
}

function getReviewCustomerSeed(slug: string, index: number): ReviewCustomerSeed {
  const base = REVIEW_CUSTOMERS[stableIndex(`${slug}-${index}`, REVIEW_CUSTOMERS.length)];
  return {
    ...base,
    managerName: base.managerName ?? base.name,
  };
}

function makeReviewerPhone(slug: string, index: number): string {
  const a = String(2000 + stableIndex(`${slug}-a-${index}`, 7000)).padStart(4, "0");
  const b = String(1000 + stableIndex(`${slug}-b-${index}`, 8000)).padStart(4, "0");
  return `010-${a}-${b}`;
}

function makeReviewComment(
  f: FreelancerSeed,
  eventTitle: string,
  venue: string,
  index: number,
  totalScore: number,
): string {
  const category = f.categories.find((item) => CATEGORY_REVIEW_DETAILS[item]);
  const categoryDetails = category ? CATEGORY_REVIEW_DETAILS[category] : undefined;
  const opening = REVIEW_OPENINGS[stableIndex(`${f.profileId}-opening-${index}`, REVIEW_OPENINGS.length)];
  const detailPool = categoryDetails?.length ? categoryDetails : REVIEW_DETAILS;
  const detail = detailPool[stableIndex(`${f.profileId}-detail-${eventTitle}-${index}`, detailPool.length)];
  const closing = REVIEW_CLOSINGS[stableIndex(`${f.profileId}-closing-${venue}-${index}`, REVIEW_CLOSINGS.length)];
  const scoreNote = totalScore >= 4.9
    ? "완성도가 기대 이상이었습니다."
    : totalScore >= 4.7
      ? "전체적으로 안정적인 진행이었습니다."
      : "필요한 부분을 성실하게 맞춰주셨습니다.";

  return `${opening} ${detail} ${scoreNote} ${closing}`;
}

function makeFreelancerReviewComment(
  customerName: string,
  eventTitle: string,
  index: number,
): string {
  const opening = FREELANCER_REVIEW_OPENINGS[stableIndex(`${customerName}-${eventTitle}-${index}`, FREELANCER_REVIEW_OPENINGS.length)];
  const closing = FREELANCER_REVIEW_CLOSINGS[stableIndex(`${eventTitle}-${customerName}-${index}`, FREELANCER_REVIEW_CLOSINGS.length)];
  return `${opening} ${closing}`;
}

async function ensureSeedReviewCustomer(
  slug: string,
  index: number,
  passwordHash: string,
) {
  const reviewer = getReviewCustomerSeed(slug, index);
  const paddedIndex = pad(index);
  const id = `seed_review_customer_${slug}_${paddedIndex}`;
  const email = `reviewer.${slug}.${paddedIndex}@voit.local`;

  const user = await upsertUser({
    id,
    email,
    name: reviewer.name,
    phone: makeReviewerPhone(slug, index),
    userType: UserType.customer,
    passwordHash,
  });

  await prisma.customerProfile.upsert({
    where: { user_id: user.id },
    update: {
      customer_type: "company",
      company_name: reviewer.companyName,
      department: reviewer.department,
      manager_name: reviewer.managerName,
      memo: "시연용 공개 후기 작성자 계정입니다.",
    },
    create: {
      id: `seed_review_customer_profile_${slug}_${paddedIndex}`,
      user_id: user.id,
      customer_type: "company",
      company_name: reviewer.companyName,
      department: reviewer.department,
      manager_name: reviewer.managerName,
      memo: "시연용 공개 후기 작성자 계정입니다.",
    },
  });

  return user;
}

async function seedCompletedReviews(
  profileId: string,
  f: FreelancerSeed,
  reviewerPasswordHash: string,
) {
  const slug = getSeedSlug(f);
  const createdScores: number[] = [];

  for (let i = 0; i < f.reviewCount; i += 1) {
    const index = i + 1;
    const scores = i === 0 ? f.review.scores : makeScoreSet(f.avgRating, i);
    const totalScore = i === 0 ? f.review.totalScore : average(scores);
    createdScores.push(totalScore);

    const basePriceOffset = ((i % 5) - 2) * 50000;
    const finalPrice = Math.max(
      f.priceMin,
      Math.min(f.priceMax, f.review.finalPrice + basePriceOffset),
    );
    const platformFee = Math.round(finalPrice * 0.1);
    const freelancerAmount = finalPrice - platformFee;
    const eventDate =
      i === 0
        ? f.review.eventDate
        : new Date(Date.UTC(2025 + (i % 2), i % 12, 5 + (i % 20), 0, 0, 0));
    const eventTitle =
      i === 0
        ? f.review.eventTitle
        : `${EVENT_TITLE_VARIANTS[i % EVENT_TITLE_VARIANTS.length]} - ${f.displayName}`;
    const venue =
      i === 0
        ? f.review.venue
        : VENUE_VARIANTS[(i + f.careerYears) % VENUE_VARIANTS.length];
    const bookingId =
      i === 0 ? f.review.bookingId : `seed_booking_${slug}_${pad(index)}`;
    const reviewId =
      i === 0 ? f.review.reviewId : `seed_review_${slug}_${pad(index)}`;
    const freelancerReviewId =
      i === 0
        ? f.review.freelancerReviewId
        : `seed_freelancer_review_${slug}_${pad(index)}`;
    const paymentId = `seed_payment_${slug}_${pad(index)}`;
    const contractId = `seed_contract_${slug}_${pad(index)}`;
    const chatRoomId = `seed_chat_room_${slug}_${pad(index)}`;
    const chatMessageId = `seed_chat_message_${slug}_${pad(index)}`;
    const offerId = `seed_offer_${slug}_${pad(index)}`;
    const reviewCustomer = await ensureSeedReviewCustomer(
      slug,
      index,
      reviewerPasswordHash,
    );
    const customerId = reviewCustomer.id;
    const reviewComment =
      i === 0
        ? f.review.comment
        : makeReviewComment(f, eventTitle, venue, i, totalScore);
    const freelancerReviewComment = makeFreelancerReviewComment(
      reviewCustomer.name,
      eventTitle,
      i,
    );

    const booking = await prisma.booking.upsert({
      where: { id: bookingId },
      update: {
        customer_id: customerId,
        freelancer_id: profileId,
        event_title: eventTitle,
        event_date: eventDate,
        start_time: i % 3 === 0 ? "10:00" : i % 3 === 1 ? "14:00" : "18:00",
        end_time: i % 3 === 0 ? "12:00" : i % 3 === 1 ? "17:00" : "21:00",
        venue,
        final_price: finalPrice,
        platform_fee: platformFee,
        freelancer_amount: freelancerAmount,
        booking_status: BookingStatus.completed,
        payment_status: PaymentStatus.fully_paid,
        settlement_status: SettlementStatus.completed,
        escrow_status: EscrowStatus.released,
        escrow_held_at: new Date(eventDate.getTime() - 1000 * 60 * 60 * 24 * 7),
        escrow_released_at: new Date(
          eventDate.getTime() + 1000 * 60 * 60 * 24 * 2,
        ),
        completion_requested_at: new Date(
          eventDate.getTime() + 1000 * 60 * 60 * 6,
        ),
        cancel_reason: null,
      },
      create: {
        id: bookingId,
        customer_id: customerId,
        freelancer_id: profileId,
        event_title: eventTitle,
        event_date: eventDate,
        start_time: i % 3 === 0 ? "10:00" : i % 3 === 1 ? "14:00" : "18:00",
        end_time: i % 3 === 0 ? "12:00" : i % 3 === 1 ? "17:00" : "21:00",
        venue,
        final_price: finalPrice,
        platform_fee: platformFee,
        freelancer_amount: freelancerAmount,
        booking_status: BookingStatus.completed,
        payment_status: PaymentStatus.fully_paid,
        settlement_status: SettlementStatus.completed,
        escrow_status: EscrowStatus.released,
        escrow_held_at: new Date(eventDate.getTime() - 1000 * 60 * 60 * 24 * 7),
        escrow_released_at: new Date(
          eventDate.getTime() + 1000 * 60 * 60 * 24 * 2,
        ),
        completion_requested_at: new Date(
          eventDate.getTime() + 1000 * 60 * 60 * 6,
        ),
      },
    });

    await prisma.payment.upsert({
      where: { booking_id: booking.id },
      update: {
        order_id: `seed_order_${slug}_${pad(index)}`,
        payment_key: `seed_payment_key_${slug}_${pad(index)}`,
        amount: finalPrice,
        method: i % 2 === 0 ? "카드" : "가상계좌",
        status: PaymentStatusToss.DONE,
        requested_at: new Date(eventDate.getTime() - 1000 * 60 * 60 * 24 * 8),
        approved_at: new Date(eventDate.getTime() - 1000 * 60 * 60 * 24 * 7),
        failure_code: null,
        failure_message: null,
        raw_response: {
          seed: true,
          provider: "toss-sandbox",
          orderName: eventTitle,
          amount: finalPrice,
        },
      },
      create: {
        id: paymentId,
        booking_id: booking.id,
        order_id: `seed_order_${slug}_${pad(index)}`,
        payment_key: `seed_payment_key_${slug}_${pad(index)}`,
        amount: finalPrice,
        method: i % 2 === 0 ? "카드" : "가상계좌",
        status: PaymentStatusToss.DONE,
        requested_at: new Date(eventDate.getTime() - 1000 * 60 * 60 * 24 * 8),
        approved_at: new Date(eventDate.getTime() - 1000 * 60 * 60 * 24 * 7),
        raw_response: {
          seed: true,
          provider: "toss-sandbox",
          orderName: eventTitle,
          amount: finalPrice,
        },
      },
    });

    await prisma.contract.upsert({
      where: { booking_id: booking.id },
      update: {
        content_json: {
          seed: true,
          title: eventTitle,
          venue,
          eventDate: eventDate.toISOString(),
          customerId,
          freelancerId: profileId,
          finalPrice,
          platformFee,
          freelancerAmount,
          terms: [
            "행사 진행 범위와 리허설 조건을 사전 합의합니다.",
            "행사 완료 승인 후 플랫폼 수수료를 제외하고 정산합니다.",
          ],
        },
        status: ContractStatus.fully_signed,
        customer_signed_at: new Date(
          eventDate.getTime() - 1000 * 60 * 60 * 24 * 6,
        ),
        customer_signature_hash: `seed_customer_signature_${slug}_${pad(index)}`,
        freelancer_signed_at: new Date(
          eventDate.getTime() - 1000 * 60 * 60 * 24 * 6 + 1000 * 60 * 30,
        ),
        freelancer_signature_hash: `seed_freelancer_signature_${slug}_${pad(index)}`,
        fully_signed_at: new Date(
          eventDate.getTime() - 1000 * 60 * 60 * 24 * 6 + 1000 * 60 * 30,
        ),
      },
      create: {
        id: contractId,
        booking_id: booking.id,
        content_json: {
          seed: true,
          title: eventTitle,
          venue,
          eventDate: eventDate.toISOString(),
          customerId,
          freelancerId: profileId,
          finalPrice,
          platformFee,
          freelancerAmount,
          terms: [
            "행사 진행 범위와 리허설 조건을 사전 합의합니다.",
            "행사 완료 승인 후 플랫폼 수수료를 제외하고 정산합니다.",
          ],
        },
        status: ContractStatus.fully_signed,
        customer_signed_at: new Date(
          eventDate.getTime() - 1000 * 60 * 60 * 24 * 6,
        ),
        customer_signature_hash: `seed_customer_signature_${slug}_${pad(index)}`,
        freelancer_signed_at: new Date(
          eventDate.getTime() - 1000 * 60 * 60 * 24 * 6 + 1000 * 60 * 30,
        ),
        freelancer_signature_hash: `seed_freelancer_signature_${slug}_${pad(index)}`,
        fully_signed_at: new Date(
          eventDate.getTime() - 1000 * 60 * 60 * 24 * 6 + 1000 * 60 * 30,
        ),
      },
    });

    const [
      punctuality,
      voice,
      understanding,
      atmosphere,
      script,
      response,
      communication,
    ] = scores;

    await prisma.review.upsert({
      where: { booking_id: booking.id },
      update: {
        customer_id: customerId,
        freelancer_id: profileId,
        punctuality_score: punctuality,
        voice_delivery_score: voice,
        event_understanding_score: understanding,
        atmosphere_score: atmosphere,
        script_score: script,
        response_score: response,
        communication_score: communication,
        total_score: totalScore,
        rehire_intent: totalScore >= 4.5,
        comment: reviewComment,
        status: ReviewStatus.published,
      },
      create: {
        id: reviewId,
        booking_id: booking.id,
        customer_id: customerId,
        freelancer_id: profileId,
        punctuality_score: punctuality,
        voice_delivery_score: voice,
        event_understanding_score: understanding,
        atmosphere_score: atmosphere,
        script_score: script,
        response_score: response,
        communication_score: communication,
        total_score: totalScore,
        rehire_intent: totalScore >= 4.5,
        comment: reviewComment,
        status: ReviewStatus.published,
      },
    });

    await prisma.freelancerReview.upsert({
      where: { booking_id: booking.id },
      update: {
        freelancer_id: profileId,
        customer_id: customerId,
        professionalism_score: 5,
        communication_score: i % 4 === 0 ? 4 : 5,
        payment_promptness_score: 5,
        respect_score: 5,
        total_score: i % 4 === 0 ? 4.8 : 5,
        would_work_again: true,
        comment: freelancerReviewComment,
        status: ReviewStatus.published,
      },
      create: {
        id: freelancerReviewId,
        booking_id: booking.id,
        freelancer_id: profileId,
        customer_id: customerId,
        professionalism_score: 5,
        communication_score: i % 4 === 0 ? 4 : 5,
        payment_promptness_score: 5,
        respect_score: 5,
        total_score: i % 4 === 0 ? 4.8 : 5,
        would_work_again: true,
        comment: freelancerReviewComment,
        status: ReviewStatus.published,
      },
    });

    if (i === 0) {
      await prisma.chatRoom.upsert({
        where: { booking_id: booking.id },
        update: {
          customer_id: customerId,
          freelancer_id: profileId,
          last_message_at: new Date(
            eventDate.getTime() - 1000 * 60 * 60 * 24 * 5,
          ),
        },
        create: {
          id: chatRoomId,
          booking_id: booking.id,
          customer_id: customerId,
          freelancer_id: profileId,
          last_message_at: new Date(
            eventDate.getTime() - 1000 * 60 * 60 * 24 * 5,
          ),
        },
      });

      await prisma.bookingOffer.upsert({
        where: { id: offerId },
        update: {
          booking_id: booking.id,
          sender_id: customerId,
          receiver_id: (
            await prisma.freelancerProfile.findUniqueOrThrow({
              where: { id: profileId },
              select: { user_id: true },
            })
          ).user_id,
          amount: finalPrice,
          message:
            "최종 진행 금액을 제안드립니다. 일정과 포함 범위를 확인 부탁드립니다.",
          status: "accepted",
          responded_at: new Date(eventDate.getTime() - 1000 * 60 * 60 * 24 * 6),
        },
        create: {
          id: offerId,
          booking_id: booking.id,
          sender_id: customerId,
          receiver_id: (
            await prisma.freelancerProfile.findUniqueOrThrow({
              where: { id: profileId },
              select: { user_id: true },
            })
          ).user_id,
          amount: finalPrice,
          message:
            "최종 진행 금액을 제안드립니다. 일정과 포함 범위를 확인 부탁드립니다.",
          status: "accepted",
          responded_at: new Date(eventDate.getTime() - 1000 * 60 * 60 * 24 * 6),
        },
      });

      await prisma.chatMessage.upsert({
        where: { id: chatMessageId },
        update: {
          room_id: chatRoomId,
          sender_id: customerId,
          message:
            "행사 자료와 큐시트 초안을 공유드렸습니다. 리허설 때 최종 순서를 맞춰보겠습니다.",
          is_read: true,
        },
        create: {
          id: chatMessageId,
          room_id: chatRoomId,
          sender_id: customerId,
          message:
            "행사 자료와 큐시트 초안을 공유드렸습니다. 리허설 때 최종 순서를 맞춰보겠습니다.",
          is_read: true,
        },
      });
    }
  }

  const avgRating =
    Math.round(
      (createdScores.reduce((sum, value) => sum + value, 0) /
        createdScores.length) *
        10,
    ) / 10;

  await prisma.freelancerProfile.update({
    where: { id: profileId },
    data: {
      avg_rating: avgRating,
      review_count: createdScores.length,
    },
  });

  return { avgRating, reviewCount: createdScores.length };
}

async function seedRequestsAndRecommendations(
  adminId: string,
  customerId: string,
  profiles: Record<string, string>,
) {
  const request = await prisma.eventRequest.upsert({
    where: { id: "seed_request_corporate_forum" },
    update: {
      customer_id: customerId,
      event_title: "2026 기업·공공 포럼 전문 진행자 섭외",
      event_type: "컨퍼런스",
      event_date: new Date("2026-07-18T00:00:00.000Z"),
      start_time: "13:00",
      end_time: "18:00",
      region: "서울",
      venue: "강남 컨퍼런스홀",
      budget_min: 700000,
      budget_max: 1800000,
      preferred_freelancer_type: ["컨퍼런스 MC", "기업행사 MC", "모더레이터"],
      preferred_styles: ["신뢰감 있는", "전문적", "격식있는"],
      required_language: "한국어",
      script_required: true,
      rehearsal_required: true,
      travel_required: false,
      description:
        "세션 전환, 패널토론, 시상식 순서가 포함된 기업·공공 포럼입니다. 안정적인 진행자 후보를 비교하고 싶습니다.",
      status: RequestStatus.recommended,
    },
    create: {
      id: "seed_request_corporate_forum",
      customer_id: customerId,
      event_title: "2026 기업·공공 포럼 전문 진행자 섭외",
      event_type: "컨퍼런스",
      event_date: new Date("2026-07-18T00:00:00.000Z"),
      start_time: "13:00",
      end_time: "18:00",
      region: "서울",
      venue: "강남 컨퍼런스홀",
      budget_min: 700000,
      budget_max: 1800000,
      preferred_freelancer_type: ["컨퍼런스 MC", "기업행사 MC", "모더레이터"],
      preferred_styles: ["신뢰감 있는", "전문적", "격식있는"],
      required_language: "한국어",
      script_required: true,
      rehearsal_required: true,
      travel_required: false,
      description:
        "세션 전환, 패널토론, 시상식 순서가 포함된 기업·공공 포럼입니다. 안정적인 진행자 후보를 비교하고 싶습니다.",
      status: RequestStatus.recommended,
    },
  });

  const recs = [
    [
      "seed_rec_forum_cho",
      profiles["MC 조혜진"],
      "공공기관 의전과 공식 행사 경험이 많아 1순위 후보로 추천합니다.",
      1,
    ],
    [
      "seed_rec_forum_seo",
      profiles["모더레이터 서민지"],
      "패널토론 질문 설계와 시간 관리에 강점이 있어 포럼 세션에 적합합니다.",
      2,
    ],
    [
      "seed_rec_forum_park",
      profiles["MC 박진행"],
      "기업행사 경험이 풍부해 안정적인 행사 운영이 가능합니다.",
      3,
    ],
    [
      "seed_rec_forum_yuna",
      profiles["글로벌 MC 정유나"],
      "영어 세션 또는 해외 연사 대응이 필요한 경우 적합한 후보입니다.",
      4,
    ],
  ] as const;

  for (const [id, freelancerId, reason, order] of recs) {
    if (!freelancerId) continue;
    await prisma.recommendation.upsert({
      where: { id },
      update: {
        request_id: request.id,
        freelancer_id: freelancerId,
        recommended_by: adminId,
        recommendation_reason: reason,
        display_order: order,
        status: RecommendationStatus.sent,
      },
      create: {
        id,
        request_id: request.id,
        freelancer_id: freelancerId,
        recommended_by: adminId,
        recommendation_reason: reason,
        display_order: order,
        status: RecommendationStatus.sent,
      },
    });
  }

  for (const displayName of [
    "MC 조혜진",
    "모더레이터 서민지",
    "글로벌 MC 정유나",
  ]) {
    const freelancerId = profiles[displayName];
    if (!freelancerId) continue;
    await prisma.savedFreelancer.upsert({
      where: {
        customer_id_freelancer_id: {
          customer_id: customerId,
          freelancer_id: freelancerId,
        },
      },
      update: {},
      create: {
        id: `seed_saved_${displayName.replace(/[^가-힣a-zA-Z0-9]/g, "_")}`,
        customer_id: customerId,
        freelancer_id: freelancerId,
      },
    });
  }
}

async function main() {
  console.log("🌱 Voit 시연용 seed 데이터 생성 시작(v7 / 후기 작성자 다양화 / 후기 47개)...");
  console.log("- 구성: 프리랜서 19명 + 시연용 고용인 1명 + 공개 후기용 의뢰인 계정");
  console.log(
    "- 영상/유튜브 링크는 생성하지 않습니다. 직접 제작한 링크를 나중에 등록하세요.",
  );
  console.log(
    "- 진행자별 2~4개씩 총 47개의 완료 예약, 결제, 계약, 고객 리뷰, 프리랜서 리뷰를 생성합니다.",
  );

  await cleanupPreviousSeedData();

  const freelancerHash = await bcrypt.hash(PASSWORDS.freelancer, 12);
  const { admin, customer, customerHash } = await seedUsers();

  const profilesByDisplayName: Record<string, string> = {};

  for (const freelancer of FREELANCERS) {
    const { profile } = await seedFreelancer(freelancer, freelancerHash);
    profilesByDisplayName[freelancer.displayName] = profile.id;
    const stats = await seedCompletedReviews(
      profile.id,
      freelancer,
      customerHash,
    );
    console.log(
      `✅ 진행자 생성: ${freelancer.displayName} / 후기 ${stats.reviewCount}개 / 평균 ${stats.avgRating}`,
    );
  }

  await seedRequestsAndRecommendations(
    admin.id,
    customer.id,
    profilesByDisplayName,
  );

  console.log("\n🎉 Voit 20명 seed 완료");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(
    `관리자   | ${admin.email} | ${process.env.ADMIN_PASSWORD || PASSWORDS.admin}`,
  );
  console.log(`고용인   | ${customer.email} | ${PASSWORDS.customer}`);
  console.log(`프리랜서 | ${FREELANCERS[0].email} | ${PASSWORDS.freelancer}`);
  console.log(`프리랜서 | ${FREELANCERS[3].email} | ${PASSWORDS.freelancer}`);
  console.log(`프리랜서 | ${FREELANCERS[9].email} | ${PASSWORDS.freelancer}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main()
  .catch((error) => {
    console.error("❌ Voit seed 실패:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
