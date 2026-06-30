/**
 * 계약서 라우터
 *
 * - POST /api/contracts/:bookingId/generate — 계약서 자동 생성(미서명)
 * - POST /api/contracts/:bookingId/accept   — 기존 호환용: 계약서 생성 + 현재 사용자 전자서명
 * - GET  /api/contracts/:bookingId          — 계약서 조회
 * - PATCH /api/contracts/:bookingId          — 서명 전 계약서 초안 수정
 * - POST /api/contracts/:bookingId/sign     — 계약서 확인 후 현재 당사자 서명
 * - GET  /api/contracts/:bookingId/html     — HTML 렌더링(브라우저 인쇄용)
 * - GET  /api/contracts/:bookingId/pdf      — PDF 다운로드
 *
 * 보안:
 *   - 예약 당사자(고객/프리랜서)만 접근 가능
 *   - 관리자도 조회/생성은 가능하지만 당사자 서명은 대신할 수 없음
 *   - 양측 서명 완료 후에는 계약 내용이 확정됨
 */

import { Router, Response, NextFunction } from "express";
import crypto from "crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "../config/database";
import { authenticate } from "../middleware/auth";
import { AuthRequest } from "../types";
import { successResponse, errorResponse } from "../utils/response";
import { createNotification, notifyContractSigned } from "../utils/notifications";

const router = Router();
router.use(authenticate);

type ContractParty = "customer" | "freelancer";

type ContractClause = {
  title: string;
  paragraphs: string[];
};

interface ContractContent {
  version: "2.0";
  generated_at: string;
  draft_revision?: number;
  draft_updated_at?: string;
  draft_updated_by?: string;
  contract_title: string;
  counterparty_type: "private" | "public";
  customer: {
    name: string;
    email: string;
    phone: string | null;
    company_name: string | null;
    department: string | null;
    manager_name: string | null;
    business_registration_number: string | null;
    address: string | null;
  };
  freelancer: {
    legal_name: string;
    display_name: string;
    email: string;
    phone: string | null;
    birth_date: string | null;
    address: string | null;
    categories: string[];
    languages: string[];
    career_years: number | null;
  };
  service: {
    event_title: string;
    event_type: string;
    event_date: string;
    start_time: string;
    end_time: string;
    region: string | null;
    venue: string | null;
    role: string;
    required_language: string | null;
    description: string | null;
    script_required: boolean;
    rehearsal_required: boolean;
    travel_required: boolean;
  };
  payment: {
    final_price: number;
    platform_fee: number;
    freelancer_amount: number;
    vat_policy: string;
    deposit_rate_percent: number;
    deposit_amount: number;
    balance_amount: number;
    settlement_note: string;
  };
  usage_rights: {
    media_scope: string;
    usage_period: string;
    commercial_reuse_note: string;
  };
  cancellation_policy: string[];
  signatures?: {
    customer?: { signer_name: string; signed_at: string; signature_hash: string };
    freelancer?: { signer_name: string; signed_at: string; signature_hash: string };
  };
  clauses: ContractClause[];
}

const CONTRACT_CREATABLE_STATUSES = [
  "accepted",
  "negotiating",
  "payment_pending",
  "confirmed",
  "completion_requested",
  "completed",
] as const;

const CONTRACT_PLATFORM_FEE_RATE = 0.1;

const updateContractSchema = z.object({
  event_title: z.string().trim().min(1, "행사명을 입력해 주세요.").max(200),
  event_date: z.string().trim().min(1, "행사 날짜를 입력해 주세요."),
  start_time: z.string().trim().min(1, "시작 시간을 입력해 주세요.").max(20),
  end_time: z.string().trim().min(1, "종료 시간을 입력해 주세요.").max(20),
  region: z.string().trim().max(100).nullable().optional(),
  venue: z.string().trim().max(200).nullable().optional(),
  role: z.string().trim().min(1, "주요 역할을 입력해 주세요.").max(200),
  required_language: z.string().trim().max(100).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  script_required: z.boolean().optional(),
  rehearsal_required: z.boolean().optional(),
  travel_required: z.boolean().optional(),
  final_price: z.number().int().positive("총 계약 금액을 입력해 주세요."),
  media_scope: z.string().trim().min(1, "활용 매체를 입력해 주세요.").max(500),
  usage_period: z.string().trim().min(1, "활용 기간을 입력해 주세요.").max(300),
  commercial_reuse_note: z.string().trim().min(1, "추가 활용 조건을 입력해 주세요.").max(800),
  cancellation_policy: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
});



const signContractSchema = z.object({
  signer_name: z.string().trim().min(2, "서명자 이름을 2자 이상 입력해 주세요.").max(100, "서명자 이름은 100자 이하로 입력해 주세요."),
  confirmation_checked: z.boolean().refine((value) => value === true, "전자서명 동의가 필요합니다."),
});

type UpdateContractInput = z.infer<typeof updateContractSchema>;

function formatNullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toDateOnly(value: Date): string {
  return value.toISOString().split("T")[0];
}

function toCurrency(value: number | null | undefined): string {
  return `${Number(value ?? 0).toLocaleString("ko-KR")}원`;
}

function calculateContractAmounts(finalPrice: number) {
  const platformFee = Math.floor(finalPrice * CONTRACT_PLATFORM_FEE_RATE);
  return {
    finalPrice,
    platformFee,
    freelancerAmount: finalPrice - platformFee,
  };
}

function parseContractDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw Object.assign(new Error("유효한 행사 날짜를 입력해 주세요."), { statusCode: 400, code: "VALIDATION_ERROR" });
  }
  return date;
}

function buildSignatureHash(userId: string, bookingId: string, timestamp: string, signerName = ""): string {
  return crypto
    .createHash("sha256")
    .update(`${userId}|${bookingId}|${timestamp}|${signerName.trim()}`)
    .digest("hex");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatKoDate(value: string | Date | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return escapeHtml(date.toLocaleDateString("ko-KR"));
}

function formatKoDateTime(value: string | Date | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return escapeHtml(date.toLocaleString("ko-KR"));
}

function isPublicCounterparty(customerType?: string | null): boolean {
  const value = customerType ?? "";
  return /공공|정부|지자체|학교|기관|공기업/.test(value);
}

function getServiceRole(categories: string[] = [], preferredTypes: string[] = []): string {
  const merged = [...preferredTypes, ...categories].filter(Boolean);
  if (merged.length === 0) return "전문 진행자(MC/아나운서/쇼호스트)";
  return merged.join(", ");
}

function buildContractContent(
  booking: NonNullable<Awaited<ReturnType<typeof getBookingWithParties>>>
): ContractContent {
  const request = booking.request;
  const quote = booking.quote;
  const customerProfile = booking.customer.customer_profile;
  const freelancer = booking.freelancer;
  const freelancerUser = freelancer.user;
  const isPublic = isPublicCounterparty(customerProfile?.customer_type);
  const depositAmount = Math.floor(booking.final_price * 0.3);
  const balanceAmount = booking.final_price - depositAmount;
  const eventType = request?.event_type || "행사";
  const role = getServiceRole(freelancer.categories, request?.preferred_freelancer_type ?? []);

  return {
    version: "2.0",
    generated_at: new Date().toISOString(),
    contract_title: `${eventType} 진행 및 출연 용역 계약`,
    counterparty_type: isPublic ? "public" : "private",
    customer: {
      name: booking.customer.name,
      email: booking.customer.email,
      phone: formatNullable(booking.customer.phone),
      company_name: formatNullable(customerProfile?.company_name),
      department: formatNullable(customerProfile?.department),
      manager_name: formatNullable(customerProfile?.manager_name) ?? booking.customer.name,
      business_registration_number: null,
      address: null,
    },
    freelancer: {
      legal_name: freelancerUser.name,
      display_name: formatNullable(freelancer.display_name) ?? freelancerUser.name,
      email: freelancerUser.email,
      phone: formatNullable(freelancerUser.phone),
      birth_date: null,
      address: null,
      categories: freelancer.categories,
      languages: freelancer.languages,
      career_years: freelancer.career_years ?? null,
    },
    service: {
      event_title: booking.event_title,
      event_type: eventType,
      event_date: toDateOnly(booking.event_date),
      start_time: booking.start_time,
      end_time: booking.end_time,
      region: formatNullable(request?.region),
      venue: formatNullable(booking.venue),
      role,
      required_language: formatNullable(request?.required_language),
      description: formatNullable(request?.description),
      script_required: quote?.script_included ?? request?.script_required ?? false,
      rehearsal_required: quote?.rehearsal_included ?? request?.rehearsal_required ?? false,
      travel_required: quote?.travel_fee_included ?? request?.travel_required ?? false,
    },
    payment: {
      final_price: booking.final_price,
      platform_fee: booking.platform_fee,
      freelancer_amount: booking.freelancer_amount,
      vat_policy: isPublic ? "부가세 포함" : "부가세 포함/별도는 양측 합의 및 세금계산서 발행 조건에 따름",
      deposit_rate_percent: isPublic ? 0 : 30,
      deposit_amount: isPublic ? 0 : depositAmount,
      balance_amount: isPublic ? booking.final_price : balanceAmount,
      settlement_note: isPublic
        ? "공공 예산 집행 지침에 따라 용역 완수 및 검수 후 지급한다."
        : "계약 체결 후 계약금 30%, 행사 종료 후 잔금 70% 지급을 기본으로 하되 플랫폼 결제/에스크로 절차를 따른다.",
    },
    usage_rights: {
      media_scope: "행사 당일 송출 및 발주자 공식 채널 게시 범위 내 사용",
      usage_period: "행사 종료 후 6개월간 게시를 기본으로 하며, 초과 사용은 별도 협의",
      commercial_reuse_note: "타사 상업 광고, 2차 편집물, 유료 광고 소재 활용은 별도 서면 합의 및 추가 사용료 지급 대상이다.",
    },
    cancellation_policy: [
      "행사 예정일 7일 전 취소 시 총 출연료의 30%를 지급한다.",
      "행사 예정일 3일 전 취소 시 총 출연료의 50%를 지급한다.",
      "행사 당일 또는 무통보 취소 시 총 출연료의 100%를 지급한다.",
      "천재지변 등 불가항력 사유는 상호 협의하여 조정한다.",
    ],
    clauses: buildStandardClauses(isPublic),
  };
}

function applyContractDraftUpdates(
  current: ContractContent,
  input: UpdateContractInput,
  updatedBy: string
): ContractContent {
  const amounts = calculateContractAmounts(input.final_price);
  const depositRate = current.counterparty_type === "public" ? 0 : current.payment.deposit_rate_percent || 30;
  const depositAmount = depositRate ? Math.floor(amounts.finalPrice * (depositRate / 100)) : 0;
  const balanceAmount = amounts.finalPrice - depositAmount;

  return {
    ...current,
    contract_title: `${input.event_title} 진행 및 출연 용역 계약`,
    draft_revision: (current.draft_revision ?? 0) + 1,
    draft_updated_at: new Date().toISOString(),
    draft_updated_by: updatedBy,
    service: {
      ...current.service,
      event_title: input.event_title,
      event_date: input.event_date,
      start_time: input.start_time,
      end_time: input.end_time,
      region: formatNullable(input.region),
      venue: formatNullable(input.venue),
      role: input.role,
      required_language: formatNullable(input.required_language),
      description: formatNullable(input.description),
      script_required: input.script_required ?? current.service.script_required,
      rehearsal_required: input.rehearsal_required ?? current.service.rehearsal_required,
      travel_required: input.travel_required ?? current.service.travel_required,
    },
    payment: {
      ...current.payment,
      final_price: amounts.finalPrice,
      platform_fee: amounts.platformFee,
      freelancer_amount: amounts.freelancerAmount,
      deposit_amount: depositAmount,
      balance_amount: balanceAmount,
    },
    usage_rights: {
      ...current.usage_rights,
      media_scope: input.media_scope,
      usage_period: input.usage_period,
      commercial_reuse_note: input.commercial_reuse_note,
    },
    cancellation_policy: input.cancellation_policy,
  };
}

function buildStandardClauses(isPublic: boolean): ContractClause[] {
  const clauses: ContractClause[] = [
    {
      title: "제1조 (목적)",
      paragraphs: [
        "본 계약은 발주자(이하 ‘갑’)가 기획·주최하는 행사 또는 프로그램의 원활한 진행을 위해 출연자(이하 ‘을’)에게 전문 진행 및 출연 용역을 위임하고, ‘을’이 이에 성실히 응하여 용역을 제공함에 있어 상호 간 권리와 의무를 규정함을 목적으로 한다.",
      ],
    },
    {
      title: "제2조 (용역의 제공 및 대본 제공 의무)",
      paragraphs: [
        "‘을’은 계약된 일시에 지정된 장소에 도착하여 리허설 및 본 행사를 성실히 수행하여야 한다.",
        "‘갑’은 ‘을’이 행사를 원활히 준비할 수 있도록 행사 예정일 최소 3일 전까지 확정된 대본, 큐시트 또는 가이드라인을 제공하여야 한다. 제공 지연으로 발생한 진행상의 과실은 ‘갑’의 책임으로 한다.",
      ],
    },
    {
      title: "제3조 (출연료 및 대금 지급 방식)",
      paragraphs: isPublic
        ? [
            "본 계약은 공공 예산 집행 지침에 따라 후불 검수 지급을 원칙으로 한다.",
            "‘을’은 용역 완수 후 ‘갑’이 요구하는 용역완수확인서, 사진, 서명부 등 증빙 제출에 협조하며, ‘갑’은 검수 및 청구물 접수 후 약정 기한 내 대금을 지급한다.",
          ]
        : [
            "‘갑’은 계약 체결 시 계약금으로 총 금액의 30%를 지급하고, 잔금 70%는 행사 종료 후 3일 이내 지급하는 것을 기본으로 한다.",
            "원천징수, 부가세, 세금계산서 발행 여부는 양측의 법적 지위 및 플랫폼 결제 정책에 따라 적용한다.",
          ],
    },
    {
      title: "제4조 (초상권 및 저작물 활용 범위)",
      paragraphs: [
        "본 계약을 통해 제작된 ‘을’의 음성, 영상, 사진 등 결과물의 이용 권한은 본 계약에서 정한 범위 내로 제한된다.",
        "‘갑’이 약정한 매체와 기간을 초과하여 ‘을’의 초상권 또는 결과물을 활용하고자 하는 경우, 반드시 별도 서면 합의 및 추가 사용료 지급 절차를 거쳐야 한다.",
      ],
    },
    {
      title: "제5조 (계약의 변경 및 지연 수당)",
      paragraphs: [
        "‘갑’의 사정으로 행사 일시, 장소, 내용 등 계약 조건이 변경될 경우 즉시 ‘을’에게 통보하여야 하며, ‘을’의 기존 스케줄과 상충할 경우 상호 합의에 따라 조정하거나 해지할 수 있다.",
        "행사 당일 ‘갑’의 준비 부족이나 진행 지연으로 예정 종료 시간보다 30분 이상 지연될 경우, 추가 용역 수당은 양측 협의에 따라 지급한다.",
      ],
    },
    {
      title: "제6조 (행사 취소에 따른 위약금 배상)",
      paragraphs: [
        "‘갑’의 귀책사유 또는 단순 변심으로 행사가 취소될 경우, ‘갑’은 ‘을’의 기회 손실 보전을 위해 계약서에 명시된 위약금 기준에 따라 배상한다.",
      ],
    },
    {
      title: "제7조 (비밀유지 및 품위유지)",
      paragraphs: [
        "‘갑’과 ‘을’은 본 계약 및 수행 과정에서 알게 된 상대방의 영업비밀, 미공개 정보, 행사 단가 등을 제3자에게 누설하여서는 안 된다.",
        "‘을’은 계약 체결 시점부터 행사 종료 시까지 사회적 미풍양속을 저해하거나 ‘갑’의 이미지에 중대한 타격을 줄 수 있는 행위를 하여서는 안 된다.",
      ],
    },
    {
      title: "제9조 (분쟁의 해결)",
      paragraphs: [
        "본 계약과 관련하여 분쟁이 발생할 경우 상호 합의로 해결하되, 합의가 이루어지지 않을 경우 ‘갑’의 소재지 관할 법원 또는 서울중앙지방법원을 관할 법원으로 한다.",
      ],
    },
  ];

  if (isPublic) {
    clauses.splice(7, 0, {
      title: "제8조 (공공기관 전용 특약 조항)",
      paragraphs: [
        "‘을’은 본 계약과 관련하여 관계 공무원이나 담당자에게 금품, 향응 등 부당한 이익을 제공하지 않는다.",
        "‘갑’과 ‘을’은 문화예술용역 환경에서 상호 인격을 존중하며, 성희롱·성폭력 등 비위 행위 발생 시 관련 절차에 따라 단호하게 조치한다.",
        "본 계약이 고용보험법상 문화예술용역 서면계약에 해당할 경우, ‘갑’과 ‘을’은 관련 신고 및 보험료 납부 절차에 협조한다.",
      ],
    });
  }

  return clauses;
}

async function getBookingWithParties(bookingId: string) {
  return prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      customer: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          customer_profile: {
            select: {
              customer_type: true,
              company_name: true,
              department: true,
              manager_name: true,
            },
          },
        },
      },
      freelancer: {
        include: {
          user: { select: { id: true, name: true, email: true, phone: true } },
        },
      },
      request: {
        select: {
          event_type: true,
          region: true,
          preferred_freelancer_type: true,
          required_language: true,
          script_required: true,
          rehearsal_required: true,
          travel_required: true,
          description: true,
        },
      },
      quote: {
        select: {
          script_included: true,
          rehearsal_included: true,
          travel_fee_included: true,
        },
      },
      chat_room: { select: { id: true } },
      contract: true,
    },
  });
}

function assertParty(
  userId: string,
  userType: string,
  booking: NonNullable<Awaited<ReturnType<typeof getBookingWithParties>>>
): ContractParty | null {
  if (userType === "admin") return "customer";
  if (booking.customer_id === userId) return "customer";
  if (booking.freelancer.user_id === userId) return "freelancer";
  return null;
}

function canCreateContract(bookingStatus: string): boolean {
  return CONTRACT_CREATABLE_STATUSES.includes(bookingStatus as (typeof CONTRACT_CREATABLE_STATUSES)[number]);
}

async function createContractIfMissing(
  tx: Prisma.TransactionClient,
  booking: NonNullable<Awaited<ReturnType<typeof getBookingWithParties>>>
) {
  if (booking.contract) return booking.contract;

  const content = buildContractContent(booking);

  return tx.contract.create({
    data: {
      booking_id: booking.id,
      content_json: content as unknown as Prisma.InputJsonValue,
      status: "draft",
    },
  });
}

async function signContractForParty(
  tx: Prisma.TransactionClient,
  booking: NonNullable<Awaited<ReturnType<typeof getBookingWithParties>>>,
  contract: NonNullable<NonNullable<Awaited<ReturnType<typeof getBookingWithParties>>>["contract"]>,
  party: ContractParty,
  userId: string,
  signerName: string
) {
  if (contract.status === "voided") {
    throw Object.assign(new Error("무효화된 계약서입니다."), { statusCode: 409, code: "CONFLICT" });
  }

  if (contract.status === "fully_signed") {
    return contract;
  }

  const isCustomer = party === "customer";
  const alreadySigned = isCustomer ? !!contract.customer_signed_at : !!contract.freelancer_signed_at;

  if (alreadySigned) {
    return contract;
  }

  const timestamp = new Date();
  const timestampIso = timestamp.toISOString();
  const normalizedSignerName = signerName.trim();
  const signatureHash = buildSignatureHash(userId, booking.id, timestampIso, normalizedSignerName);
  const otherAlreadySigned = isCustomer ? !!contract.freelancer_signed_at : !!contract.customer_signed_at;
  const newStatus = otherAlreadySigned ? "fully_signed" : isCustomer ? "pending_freelancer" : "pending_customer";
  const content = (contract.content_json ?? {}) as unknown as ContractContent;
  const updatedContent: ContractContent = {
    ...content,
    signatures: {
      ...(content.signatures ?? {}),
      [isCustomer ? "customer" : "freelancer"]: {
        signer_name: normalizedSignerName,
        signed_at: timestampIso,
        signature_hash: signatureHash,
      },
    },
  };

  const updatedContract = await tx.contract.update({
    where: { id: contract.id },
    data: {
      ...(isCustomer
        ? {
            customer_signed_at: timestamp,
            customer_signature_hash: signatureHash,
          }
        : {
            freelancer_signed_at: timestamp,
            freelancer_signature_hash: signatureHash,
          }),
      content_json: updatedContent as unknown as Prisma.InputJsonValue,
      status: newStatus,
      ...(newStatus === "fully_signed" ? { fully_signed_at: timestamp } : {}),
    },
  });

  if (newStatus === "fully_signed") {
    if (["pending", "negotiating", "accepted"].includes(booking.booking_status)) {
      await tx.booking.update({
        where: { id: booking.id },
        data: { booking_status: "payment_pending" },
      });
    }

    if (booking.chat_room) {
      await tx.chatMessage.create({
        data: {
          room_id: booking.chat_room.id,
          sender_id: null,
          message: "양측 전자서명이 완료되었습니다. 계약이 성사되어 결제 단계로 전환되었습니다.",
          message_type: "system",
        },
      });
      await tx.chatRoom.update({
        where: { id: booking.chat_room.id },
        data: { last_message_at: timestamp },
      });
    }

    await notifyContractSigned(tx, {
      customerUserId: booking.customer_id,
      freelancerUserId: booking.freelancer.user_id,
      eventTitle: booking.event_title,
      bookingId: booking.id,
    });
  } else {
    const otherUserId = isCustomer ? booking.freelancer.user_id : booking.customer_id;
    const linkUrl = booking.chat_room
      ? isCustomer
        ? `/freelancer/chats/${booking.chat_room.id}`
        : `/customer/chats/${booking.chat_room.id}`
      : `/contracts/${booking.id}`;

    await createNotification(tx, {
      user_id: otherUserId,
      type: "contract_pending",
      title: "계약 동의 요청",
      message: `상대방이 "${booking.event_title}" 계약하기를 완료했습니다. 계약을 확인하고 동의해 주세요.`,
      link_url: linkUrl,
    });
  }

  return updatedContract;
}

async function loadAuthorizedBooking(req: AuthRequest, res: Response) {
  const { bookingId } = req.params;
  const booking = await getBookingWithParties(bookingId);

  if (!booking) {
    errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
    return null;
  }

  const party = assertParty(req.user!.userId, req.user!.userType, booking);
  if (!party) {
    errorResponse(res, "FORBIDDEN", "접근 권한이 없습니다.", [], 403);
    return null;
  }

  return { booking, party };
}

// ─── POST /api/contracts/:bookingId/generate ─────────────────

router.post("/:bookingId/generate", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const loaded = await loadAuthorizedBooking(req, res);
    if (!loaded) return;
    const { booking } = loaded;

    if (booking.contract) {
      return successResponse(res, booking.contract, "이미 계약서가 생성되어 있습니다.");
    }

    if (!canCreateContract(booking.booking_status)) {
      return errorResponse(
        res,
        "CONFLICT",
        "진행자 수락 후 상담 단계부터 계약서를 생성할 수 있습니다.",
        [],
        409
      );
    }

    const contract = await prisma.$transaction((tx) => createContractIfMissing(tx, booking));

    return successResponse(res, contract, "계약서가 생성되었습니다.", 201);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/contracts/:bookingId ──────────────────────────
// 계약서 초안 수정: 양측 모두 서명하기 전까지만 가능

router.patch("/:bookingId", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const loaded = await loadAuthorizedBooking(req, res);
    if (!loaded) return;
    const { booking } = loaded;

    const contract = booking.contract;
    if (!contract) {
      return errorResponse(res, "NOT_FOUND", "계약서 초안이 없습니다.", [], 404);
    }

    if (
      contract.status !== "draft" ||
      contract.customer_signed_at ||
      contract.freelancer_signed_at ||
      contract.fully_signed_at
    ) {
      return errorResponse(
        res,
        "CONFLICT",
        "서명이 시작된 계약서는 직접 수정할 수 없습니다. 변경이 필요하면 새 계약 절차를 진행해 주세요.",
        [],
        409
      );
    }

    const input = updateContractSchema.parse(req.body);
    const nextContent = applyContractDraftUpdates(getContractContent(contract), input, req.user!.userId);
    const amounts = calculateContractAmounts(input.final_price);

    const updated = await prisma.$transaction(async (tx) => {
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          event_title: input.event_title,
          event_date: parseContractDate(input.event_date),
          start_time: input.start_time,
          end_time: input.end_time,
          venue: formatNullable(input.venue),
          final_price: amounts.finalPrice,
          platform_fee: amounts.platformFee,
          freelancer_amount: amounts.freelancerAmount,
        },
      });

      const updatedContract = await tx.contract.update({
        where: { id: contract.id },
        data: {
          content_json: nextContent as unknown as Prisma.InputJsonValue,
          status: "draft",
        },
      });

      if (booking.chat_room) {
        await tx.chatMessage.create({
          data: {
            room_id: booking.chat_room.id,
            sender_id: null,
            message: "계약서 초안 조건이 수정되었습니다. 변경된 조건을 확인한 뒤 서명해 주세요.",
            message_type: "system",
          },
        });
        await tx.chatRoom.update({
          where: { id: booking.chat_room.id },
          data: { last_message_at: new Date() },
        });
      }

      return updatedContract;
    });

    return successResponse(res, updated, "계약서 초안이 수정되었습니다.");
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/contracts/:bookingId/accept ───────────────────
// 기존 화면 호환용: 계약서를 자동 생성하고 현재 당사자의 전자서명을 기록합니다.

router.post("/:bookingId/accept", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, userType } = req.user!;

    if (userType === "admin") {
      return errorResponse(res, "FORBIDDEN", "관리자는 계약 당사자 동의를 대신할 수 없습니다.", [], 403);
    }

    const loaded = await loadAuthorizedBooking(req, res);
    if (!loaded) return;
    const { booking, party } = loaded;

    if (!canCreateContract(booking.booking_status)) {
      return errorResponse(
        res,
        "CONFLICT",
        "진행자 수락 후 상담 단계부터 계약할 수 있습니다.",
        [],
        409
      );
    }

    const signerName =
      party === "customer"
        ? booking.customer.name ?? "고객"
        : booking.freelancer.display_name ?? booking.freelancer.user.name;

    const updated = await prisma.$transaction(async (tx) => {
      const contract = await createContractIfMissing(tx, booking);
      return signContractForParty(tx, booking, contract, party, userId, signerName);
    });

    const message =
      updated.status === "fully_signed"
        ? "양측 계약이 성사되었습니다. 자동 계약서가 확정되었습니다."
        : "계약 동의가 완료되었습니다. 상대방의 동의를 기다리고 있습니다.";

    return successResponse(res, updated, message);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/contracts/:bookingId ───────────────────────────

router.get("/:bookingId", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const loaded = await loadAuthorizedBooking(req, res);
    if (!loaded) return;

    if (!loaded.booking.contract) {
      return errorResponse(res, "NOT_FOUND", "계약서가 없습니다.", [], 404);
    }

    return successResponse(res, loaded.booking.contract);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/contracts/:bookingId/sign ─────────────────────
// 기존 화면 호환용. 계약서가 이미 있으면 현재 당사자 서명을 기록합니다.

router.post("/:bookingId/sign", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, userType } = req.user!;

    if (userType === "admin") {
      return errorResponse(res, "FORBIDDEN", "관리자는 계약 당사자 서명을 대신할 수 없습니다.", [], 403);
    }

    const parsed = signContractSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return errorResponse(res, "VALIDATION_ERROR", "서명 정보를 확인해 주세요.", parsed.error.issues, 400);
    }

    const loaded = await loadAuthorizedBooking(req, res);
    if (!loaded) return;
    const { booking, party } = loaded;

    const contract = booking.contract;
    if (!contract) {
      return errorResponse(res, "NOT_FOUND", "계약서가 없습니다.", [], 404);
    }

    const updated = await prisma.$transaction((tx) => signContractForParty(tx, booking, contract, party, userId, parsed.data.signer_name));

    const message =
      updated.status === "fully_signed"
        ? "양측 서명이 완료되었습니다."
        : "서명이 완료되었습니다. 상대방의 서명을 기다리고 있습니다.";

    return successResponse(res, updated, message);
  } catch (err) {
    next(err);
  }
});

function contractHtml(c: ContractContent, contract: NonNullable<Awaited<ReturnType<typeof getBookingWithParties>>>["contract"]): string {
  const customerCompany = c.customer.company_name || c.customer.name;
  const customerManager = c.customer.manager_name || c.customer.name;
  const freelancerDisplay = c.freelancer.display_name || c.freelancer.legal_name;
  const clauseHtml = c.clauses
    .map(
      (clause) => `
        <h2>${escapeHtml(clause.title)}</h2>
        ${clause.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("\n")}`
    )
    .join("\n");
  const cancellationHtml = c.cancellation_policy.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n");

  const customerSignature = c.signatures?.customer;
  const freelancerSignature = c.signatures?.freelancer;
  const customerSignatureHtml = contract?.customer_signed_at
    ? `<p class="signed">서명 완료</p><p class="sig-label">서명자: ${escapeHtml(customerSignature?.signer_name || customerManager)}</p><p class="sig-label">${formatKoDateTime(contract.customer_signed_at)}</p><p class="sig-hash">Hash: ${escapeHtml(contract.customer_signature_hash)}</p>`
    : "<p class='pending'>서명 대기 중</p>";
  const freelancerSignatureHtml = contract?.freelancer_signed_at
    ? `<p class="signed">서명 완료</p><p class="sig-label">서명자: ${escapeHtml(freelancerSignature?.signer_name || freelancerDisplay)}</p><p class="sig-label">${formatKoDateTime(contract.freelancer_signed_at)}</p><p class="sig-hash">Hash: ${escapeHtml(contract.freelancer_signature_hash)}</p>`
    : "<p class='pending'>서명 대기 중</p>";

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(c.contract_title)} - ${escapeHtml(c.service.event_title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif; max-width: 880px; margin: 40px auto; color: #111827; line-height: 1.72; padding: 0 24px; }
  h1 { text-align: center; border-bottom: 2px solid #111827; padding-bottom: 14px; margin-bottom: 8px; font-size: 28px; }
  h2 { margin-top: 30px; font-size: 17px; border-left: 4px solid #4F46E5; padding-left: 10px; }
  h3 { margin-top: 22px; font-size: 15px; }
  p { margin: 8px 0; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; margin: 14px 0 20px; }
  th, td { border: 1px solid #D1D5DB; padding: 9px 12px; text-align: left; font-size: 13px; vertical-align: top; }
  th { width: 28%; background: #F3F4F6; color: #374151; }
  ul { padding-left: 22px; }
  li { margin-bottom: 6px; font-size: 13px; }
  .meta { text-align:center; color:#6B7280; font-size:12px; margin-bottom: 28px; }
  .notice { border: 1px solid #DDD6FE; background: #F5F3FF; color: #3730A3; padding: 12px 14px; border-radius: 12px; font-size: 13px; margin: 18px 0; }
  .sig-table td { height: 116px; }
  .signed { font-weight: 700; color: #166534; }
  .pending { color: #9CA3AF; }
  .sig-label { font-size: 12px; color: #6B7280; }
  .sig-hash { font-size: 10px; color: #6B7280; word-break: break-all; }
  .print-actions { position: sticky; top: 0; display: flex; justify-content: flex-end; gap: 8px; padding: 12px 0; background: rgba(255,255,255,.92); }
  .print-actions button { border: 1px solid #D1D5DB; background: #111827; color: white; border-radius: 8px; padding: 8px 12px; cursor: pointer; }
  @media print { body { margin: 12mm auto; padding: 0; } .print-actions { display:none; } h1 { font-size: 23px; } h2 { break-after: avoid; } table { break-inside: avoid; } }
</style>
</head>
<body>
<div class="print-actions"><button type="button" onclick="window.print()">인쇄 / PDF로 저장</button></div>
<h1>${escapeHtml(c.contract_title)}</h1>
<p class="meta">계약 생성일: ${formatKoDate(c.generated_at)} · VOIT 전자계약 자동 생성 문서</p>

<div class="notice">본 계약서는 양측이 계약 조건을 확인한 뒤 별도 전자서명을 완료하면 성립되며, 서명자명·서명 시각·해시값이 기록됩니다.</div>

<h2>1. 계약의 기본 정보</h2>
<table>
  <tr><th>계약명</th><td>${escapeHtml(c.contract_title)}</td></tr>
  <tr><th>발주자(갑)</th><td>${escapeHtml(customerCompany)} / 담당자: ${escapeHtml(customerManager)}<br>Email: ${escapeHtml(c.customer.email)}${c.customer.phone ? `<br>연락처: ${escapeHtml(c.customer.phone)}` : ""}</td></tr>
  <tr><th>출연자(을)</th><td>${escapeHtml(freelancerDisplay)} (${escapeHtml(c.freelancer.legal_name)})<br>Email: ${escapeHtml(c.freelancer.email)}${c.freelancer.phone ? `<br>연락처: ${escapeHtml(c.freelancer.phone)}` : ""}</td></tr>
  <tr><th>용역 내용</th><td>${escapeHtml(c.service.event_title)} / ${escapeHtml(c.service.role)}</td></tr>
  <tr><th>일시</th><td>${escapeHtml(c.service.event_date)} ${escapeHtml(c.service.start_time)} ~ ${escapeHtml(c.service.end_time)}</td></tr>
  <tr><th>장소</th><td>${escapeHtml([c.service.region, c.service.venue].filter(Boolean).join(" · ") || "미정")}</td></tr>
</table>

<h2>2. 용역 범위</h2>
<table>
  <tr><th>행사 유형</th><td>${escapeHtml(c.service.event_type)}</td></tr>
  <tr><th>필요 언어</th><td>${escapeHtml(c.service.required_language || "별도 지정 없음")}</td></tr>
  <tr><th>대본 작성</th><td>${c.service.script_required ? "포함" : "미포함"}</td></tr>
  <tr><th>리허설</th><td>${c.service.rehearsal_required ? "포함" : "미포함"}</td></tr>
  <tr><th>출장</th><td>${c.service.travel_required ? "포함 또는 협의" : "별도 지정 없음"}</td></tr>
  <tr><th>요청 설명</th><td>${escapeHtml(c.service.description || "-")}</td></tr>
</table>

<h2>3. 출연료 및 대금 지급</h2>
<table>
  <tr><th>총 계약 금액</th><td>${toCurrency(c.payment.final_price)} (${escapeHtml(c.payment.vat_policy)})</td></tr>
  <tr><th>계약금</th><td>${c.payment.deposit_rate_percent ? `${c.payment.deposit_rate_percent}% · ${toCurrency(c.payment.deposit_amount)}` : "공공/후불 검수 지급"}</td></tr>
  <tr><th>잔금</th><td>${toCurrency(c.payment.balance_amount)}</td></tr>
  <tr><th>플랫폼 수수료</th><td>${toCurrency(c.payment.platform_fee)}</td></tr>
  <tr><th>진행자 정산 예정액</th><td>${toCurrency(c.payment.freelancer_amount)}</td></tr>
  <tr><th>지급 방식</th><td>${escapeHtml(c.payment.settlement_note)}</td></tr>
</table>

<h2>4. 초상권 및 저작물 활용</h2>
<table>
  <tr><th>활용 매체</th><td>${escapeHtml(c.usage_rights.media_scope)}</td></tr>
  <tr><th>활용 기간</th><td>${escapeHtml(c.usage_rights.usage_period)}</td></tr>
  <tr><th>추가 활용</th><td>${escapeHtml(c.usage_rights.commercial_reuse_note)}</td></tr>
</table>

${clauseHtml}

<h2>취소 위약금 기준</h2>
<ul>${cancellationHtml}</ul>

<h2>전자서명</h2>
<table class="sig-table">
  <tr><th>발주자(갑)</th><th>출연자(을)</th></tr>
  <tr>
    <td>${customerSignatureHtml}</td>
    <td>${freelancerSignatureHtml}</td>
  </tr>
</table>

<p style="margin-top:34px;font-size:12px;color:#6B7280;text-align:center;">본 계약의 성립을 증명하기 위해 VOIT 시스템의 전자서명 기록으로 서명 또는 날인을 대체합니다.</p>
</body>
</html>`;
}

function contractTextLines(c: ContractContent, contract: NonNullable<Awaited<ReturnType<typeof getBookingWithParties>>>["contract"]): string[] {
  const customerCompany = c.customer.company_name || c.customer.name;
  const customerManager = c.customer.manager_name || c.customer.name;
  const freelancerDisplay = c.freelancer.display_name || c.freelancer.legal_name;
  const lines: string[] = [];

  lines.push(c.contract_title);
  lines.push(`계약 생성일: ${new Date(c.generated_at).toLocaleDateString("ko-KR")}`);
  lines.push("");
  lines.push("1. 계약의 기본 정보");
  lines.push(`계약명: ${c.contract_title}`);
  lines.push(`발주자(갑): ${customerCompany} / 담당자: ${customerManager} / ${c.customer.email}${c.customer.phone ? ` / ${c.customer.phone}` : ""}`);
  lines.push(`출연자(을): ${freelancerDisplay} (${c.freelancer.legal_name}) / ${c.freelancer.email}${c.freelancer.phone ? ` / ${c.freelancer.phone}` : ""}`);
  lines.push(`용역 내용: ${c.service.event_title} / ${c.service.role}`);
  lines.push(`일시: ${c.service.event_date} ${c.service.start_time} ~ ${c.service.end_time}`);
  lines.push(`장소: ${[c.service.region, c.service.venue].filter(Boolean).join(" · ") || "미정"}`);
  lines.push("");
  lines.push("2. 용역 범위");
  lines.push(`행사 유형: ${c.service.event_type}`);
  lines.push(`필요 언어: ${c.service.required_language || "별도 지정 없음"}`);
  lines.push(`대본 작성: ${c.service.script_required ? "포함" : "미포함"}`);
  lines.push(`리허설: ${c.service.rehearsal_required ? "포함" : "미포함"}`);
  lines.push(`출장: ${c.service.travel_required ? "포함 또는 협의" : "별도 지정 없음"}`);
  if (c.service.description) lines.push(`요청 설명: ${c.service.description}`);
  lines.push("");
  lines.push("3. 출연료 및 대금 지급");
  lines.push(`총 계약 금액: ${toCurrency(c.payment.final_price)} (${c.payment.vat_policy})`);
  lines.push(`계약금: ${c.payment.deposit_rate_percent ? `${c.payment.deposit_rate_percent}% · ${toCurrency(c.payment.deposit_amount)}` : "공공/후불 검수 지급"}`);
  lines.push(`잔금: ${toCurrency(c.payment.balance_amount)}`);
  lines.push(`플랫폼 수수료: ${toCurrency(c.payment.platform_fee)}`);
  lines.push(`진행자 정산 예정액: ${toCurrency(c.payment.freelancer_amount)}`);
  lines.push(`지급 방식: ${c.payment.settlement_note}`);
  lines.push("");
  lines.push("4. 초상권 및 저작물 활용");
  lines.push(`활용 매체: ${c.usage_rights.media_scope}`);
  lines.push(`활용 기간: ${c.usage_rights.usage_period}`);
  lines.push(`추가 활용: ${c.usage_rights.commercial_reuse_note}`);
  lines.push("");

  c.clauses.forEach((clause) => {
    lines.push(clause.title);
    clause.paragraphs.forEach((paragraph) => lines.push(paragraph));
    lines.push("");
  });

  lines.push("취소 위약금 기준");
  c.cancellation_policy.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  lines.push("");
  lines.push("전자서명");
  lines.push(`발주자(갑): ${contract?.customer_signed_at ? `서명 완료 ${new Date(contract.customer_signed_at).toLocaleString("ko-KR")} / 서명자: ${c.signatures?.customer?.signer_name || c.customer.manager_name || c.customer.name}` : "서명 대기 중"}`);
  lines.push(`출연자(을): ${contract?.freelancer_signed_at ? `서명 완료 ${new Date(contract.freelancer_signed_at).toLocaleString("ko-KR")} / 서명자: ${c.signatures?.freelancer?.signer_name || c.freelancer.display_name || c.freelancer.legal_name}` : "서명 대기 중"}`);
  if (contract?.customer_signature_hash) lines.push(`갑 서명 해시: ${contract.customer_signature_hash}`);
  if (contract?.freelancer_signature_hash) lines.push(`을 서명 해시: ${contract.freelancer_signature_hash}`);

  return lines;
}

function wrapLine(line: string, maxChars = 48): string[] {
  if (!line) return [""];
  const chunks: string[] = [];
  let current = "";

  for (const char of line) {
    const next = current + char;
    const weight = Array.from(next).reduce((sum, item) => sum + (item.charCodeAt(0) > 127 ? 1.6 : 1), 0);
    if (weight > maxChars && current) {
      chunks.push(current);
      current = char;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function utf16beHex(value: string): string {
  const le = Buffer.from(value, "utf16le");
  for (let i = 0; i < le.length; i += 2) {
    const a = le[i];
    le[i] = le[i + 1];
    le[i + 1] = a;
  }
  return le.toString("hex").toUpperCase();
}

function pdfTextCommand(line: string, fontSize: number, yMove: number): string {
  return `0 -${yMove} Td /F1 ${fontSize} Tf <${utf16beHex(line)}> Tj\n`;
}

function buildPdf(lines: string[]): Buffer {
  const flattened = lines.flatMap((line) => wrapLine(line));
  const pages: string[][] = [];
  let current: string[] = [];
  const maxLinesPerPage = 44;

  flattened.forEach((line) => {
    if (current.length >= maxLinesPerPage) {
      pages.push(current);
      current = [];
    }
    current.push(line);
  });
  if (current.length > 0) pages.push(current);

  const objects: string[] = [];
  const addObject = (body: string) => {
    objects.push(body);
    return objects.length;
  };

  const catalogId = addObject("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = addObject("PAGES_PLACEHOLDER");
  const fontId = addObject("<< /Type /Font /Subtype /Type0 /BaseFont /HYGoThic-Medium /Encoding /UniKS-UCS2-H /DescendantFonts [4 0 R] >>");
  addObject("<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYGoThic-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 2 >> /FontDescriptor 5 0 R >>");
  addObject("<< /Type /FontDescriptor /FontName /HYGoThic-Medium /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>");

  const pageIds: number[] = [];

  pages.forEach((pageLines) => {
    let content = "BT\n/F1 16 Tf\n50 800 Td\n";
    pageLines.forEach((line, index) => {
      const isTitle = index === 0 && pageIds.length === 0;
      const isSection = /^([0-9]+\.|제[0-9]+조|취소|전자서명)/.test(line);
      const fontSize = isTitle ? 16 : isSection ? 12 : 10;
      const yMove = isTitle ? 24 : 17;
      content += pdfTextCommand(line, fontSize, yMove);
    });
    content += "ET\n";

    const contentBuffer = Buffer.from(content, "binary");
    const contentId = addObject(`<< /Length ${contentBuffer.length} >>\nstream\n${content}endstream`);
    const pageId = addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  });

  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  objects[catalogId - 1] = "<< /Type /Catalog /Pages 2 0 R >>";

  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, "binary");
}

function getContractContent(contract: NonNullable<NonNullable<Awaited<ReturnType<typeof getBookingWithParties>>>["contract"]>): ContractContent {
  const content = contract.content_json as unknown as ContractContent;
  if (content.version === "2.0") return content;

  // 구버전 계약서가 이미 존재하는 경우에도 새 양식 렌더링이 가능한 최소 변환을 제공합니다.
  return {
    version: "2.0",
    generated_at: String(content.generated_at ?? contract.created_at),
    contract_title: "행사 진행 및 출연 용역 계약",
    counterparty_type: "private",
    customer: {
      name: String((content as unknown as Record<string, unknown>).customer_name ?? "고객"),
      email: String((content as unknown as Record<string, unknown>).customer_email ?? ""),
      phone: null,
      company_name: null,
      department: null,
      manager_name: String((content as unknown as Record<string, unknown>).customer_name ?? "고객"),
      business_registration_number: null,
      address: null,
    },
    freelancer: {
      legal_name: String((content as unknown as Record<string, unknown>).freelancer_name ?? "진행자"),
      display_name: String((content as unknown as Record<string, unknown>).freelancer_display_name ?? (content as unknown as Record<string, unknown>).freelancer_name ?? "진행자"),
      email: "",
      phone: null,
      birth_date: null,
      address: null,
      categories: [],
      languages: [],
      career_years: null,
    },
    service: {
      event_title: String((content as unknown as Record<string, unknown>).event_title ?? "행사"),
      event_type: "행사",
      event_date: String((content as unknown as Record<string, unknown>).event_date ?? ""),
      start_time: String((content as unknown as Record<string, unknown>).start_time ?? ""),
      end_time: String((content as unknown as Record<string, unknown>).end_time ?? ""),
      region: null,
      venue: String((content as unknown as Record<string, unknown>).venue ?? "") || null,
      role: "전문 진행자",
      required_language: null,
      description: null,
      script_required: Boolean((content as unknown as Record<string, unknown>).script_included),
      rehearsal_required: Boolean((content as unknown as Record<string, unknown>).rehearsal_included),
      travel_required: Boolean((content as unknown as Record<string, unknown>).travel_included),
    },
    payment: {
      final_price: Number((content as unknown as Record<string, unknown>).final_price ?? 0),
      platform_fee: Number((content as unknown as Record<string, unknown>).platform_fee ?? 0),
      freelancer_amount: Number((content as unknown as Record<string, unknown>).freelancer_amount ?? 0),
      vat_policy: "부가세 포함/별도는 양측 합의에 따름",
      deposit_rate_percent: 30,
      deposit_amount: Math.floor(Number((content as unknown as Record<string, unknown>).final_price ?? 0) * 0.3),
      balance_amount: Math.ceil(Number((content as unknown as Record<string, unknown>).final_price ?? 0) * 0.7),
      settlement_note: "플랫폼 결제/에스크로 절차를 따른다.",
    },
    usage_rights: {
      media_scope: "행사 당일 송출 및 발주자 공식 채널 게시 범위 내 사용",
      usage_period: "행사 종료 후 6개월간 게시를 기본으로 함",
      commercial_reuse_note: "초과 사용은 별도 협의한다.",
    },
    cancellation_policy: [
      "행사 예정일 7일 전 취소 시 총 출연료의 30%를 지급한다.",
      "행사 예정일 3일 전 취소 시 총 출연료의 50%를 지급한다.",
      "행사 당일 또는 무통보 취소 시 총 출연료의 100%를 지급한다.",
    ],
    clauses: buildStandardClauses(false),
  };
}

// ─── GET /api/contracts/:bookingId/html ──────────────────────

router.get("/:bookingId/html", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const loaded = await loadAuthorizedBooking(req, res);
    if (!loaded) return;

    const contract = loaded.booking.contract;
    if (!contract) {
      return errorResponse(res, "NOT_FOUND", "계약서를 찾을 수 없습니다.", [], 404);
    }

    const html = contractHtml(getContractContent(contract), contract);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    return res.send(html);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/contracts/:bookingId/pdf ───────────────────────

router.get("/:bookingId/pdf", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const loaded = await loadAuthorizedBooking(req, res);
    if (!loaded) return;

    const contract = loaded.booking.contract;
    if (!contract) {
      return errorResponse(res, "NOT_FOUND", "계약서를 찾을 수 없습니다.", [], 404);
    }

    if (contract.status !== "fully_signed") {
      return errorResponse(res, "CONFLICT", "양측 서명 완료 후 PDF 계약서를 다운로드할 수 있습니다.", [], 409);
    }

    const content = getContractContent(contract);
    const pdf = buildPdf(contractTextLines(content, contract));
    const safeName = encodeURIComponent(`${content.service.event_title}-계약서.pdf`);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="contract.pdf"; filename*=UTF-8''${safeName}`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.send(pdf);
  } catch (err) {
    next(err);
  }
});

export default router;
