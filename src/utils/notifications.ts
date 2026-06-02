/**
 * 알림 생성 유틸리티
 *
 * - createNotification: DB 저장 + SSE 실시간 푸시
 * - 5종 필수 알림 헬퍼 함수 제공
 *
 * SRP: 알림 생성 로직만 담당
 * OCP: 새 알림 타입은 헬퍼 함수 추가만으로 확장
 */

import { Prisma, PrismaClient } from "@prisma/client";
import { pushNotificationToUser } from "../routes/notifications";
import { NotificationType } from "./notificationTypes";

type PrismaWriter = PrismaClient | Prisma.TransactionClient;

export type NotificationInput = {
  user_id: string;
  type: string;
  title: string;
  message: string;
  link_url?: string | null;
};

/**
 * 알림 생성: DB 저장 후 SSE 실시간 푸시
 */
export async function createNotification(
  prismaClient: PrismaWriter,
  input: NotificationInput
) {
  const created = await prismaClient.notification.create({
    data: {
      user_id: input.user_id,
      type: input.type,
      title: input.title,
      message: input.message,
      link_url: input.link_url ?? null,
    },
  });

  // SSE 실시간 푸시 (fire-and-forget, 연결 없으면 무시)
  pushNotificationToUser(input.user_id, created);

  return created;
}

// ─── 5종 필수 알림 헬퍼 ─────────────────────────────────────

/** 1. 예약 요청 생성 → 프리랜서에게 */
export async function notifyBookingRequested(
  prismaClient: PrismaWriter,
  opts: {
    freelancerUserId: string;
    customerName: string;
    eventTitle: string;
    chatRoomId: string;
  }
): Promise<void> {
  await createNotification(prismaClient, {
    user_id: opts.freelancerUserId,
    type: NotificationType.BOOKING_REQUESTED,
    title: "새 예약 요청",
    message: `${opts.customerName}님이 "${opts.eventTitle}" 행사 예약을 요청했습니다.`,
    link_url: `/freelancer/chats/${opts.chatRoomId}`,
  });
}

/** 2. 예약 확정 → 고객에게 */
export async function notifyBookingConfirmed(
  prismaClient: PrismaWriter,
  opts: {
    customerUserId: string;
    freelancerName: string;
    eventTitle: string;
    bookingId: string;
  }
): Promise<void> {
  await createNotification(prismaClient, {
    user_id: opts.customerUserId,
    type: NotificationType.BOOKING_CONFIRMED,
    title: "예약이 확정되었습니다",
    message: `${opts.freelancerName} 진행자와의 "${opts.eventTitle}" 예약이 확정되었습니다.`,
    link_url: `/customer/bookings/${opts.bookingId}/payment`,
  });
}

/** 3. 결제 완료 → 고객 + 프리랜서 양측 */
export async function notifyPaymentCompleted(
  prismaClient: PrismaWriter,
  opts: {
    customerUserId: string;
    freelancerUserId: string;
    eventTitle: string;
    amount: number;
    bookingId: string;
  }
): Promise<void> {
  const amountStr = opts.amount.toLocaleString("ko-KR");

  await Promise.all([
    createNotification(prismaClient, {
      user_id: opts.customerUserId,
      type: NotificationType.PAYMENT_COMPLETED,
      title: "결제 완료",
      message: `"${opts.eventTitle}" 행사 결제 ${amountStr}원이 완료되었습니다.`,
      link_url: `/customer/bookings`,
    }),
    createNotification(prismaClient, {
      user_id: opts.freelancerUserId,
      type: NotificationType.PAYMENT_COMPLETED,
      title: "결제 확인",
      message: `"${opts.eventTitle}" 행사 고객 결제가 확인되었습니다. 에스크로 보관 중입니다.`,
      link_url: `/freelancer/bookings`,
    }),
  ]);
}

/** 4. 후기 작성 안내 → 행사 완료 후 양측 */
export async function notifyReviewRequested(
  prismaClient: PrismaWriter,
  opts: {
    customerUserId: string;
    freelancerUserId: string;
    eventTitle: string;
    bookingId: string;
  }
): Promise<void> {
  await Promise.all([
    createNotification(prismaClient, {
      user_id: opts.customerUserId,
      type: NotificationType.REVIEW_REQUESTED,
      title: "후기를 작성해 주세요",
      message: `"${opts.eventTitle}" 행사가 완료되었습니다. 진행자에 대한 후기를 작성해 주세요.`,
      link_url: `/reviews/new?bookingId=${opts.bookingId}`,
    }),
    createNotification(prismaClient, {
      user_id: opts.freelancerUserId,
      type: NotificationType.REVIEW_REQUESTED,
      title: "의뢰인 후기를 작성해 주세요",
      message: `"${opts.eventTitle}" 행사가 완료되었습니다. 의뢰인에 대한 후기를 작성해 주세요.`,
      link_url: `/freelancer/reviews/new?bookingId=${opts.bookingId}`,
    }),
  ]);
}

/** 5. 계약서 양측 서명 완료 → 양측
 *
 * [FIX] contractId → bookingId
 * 프론트엔드 라우트가 /contracts/:bookingId 기준이므로 bookingId로 통일
 */
export async function notifyContractSigned(
  prismaClient: PrismaWriter,
  opts: {
    customerUserId: string;
    freelancerUserId: string;
    eventTitle: string;
    bookingId: string; // ← contractId 아닌 bookingId
  }
): Promise<void> {
  const link = `/contracts/${opts.bookingId}`;

  await Promise.all([
    createNotification(prismaClient, {
      user_id: opts.customerUserId,
      type: NotificationType.CONTRACT_SIGNED,
      title: "계약서 서명 완료",
      message: `"${opts.eventTitle}" 계약서에 양측 서명이 완료되었습니다.`,
      link_url: link,
    }),
    createNotification(prismaClient, {
      user_id: opts.freelancerUserId,
      type: NotificationType.CONTRACT_SIGNED,
      title: "계약서 서명 완료",
      message: `"${opts.eventTitle}" 계약서에 양측 서명이 완료되었습니다.`,
      link_url: link,
    }),
  ]);
}

/** 에스크로 정산 완료 → 프리랜서에게 */
export async function notifyEscrowReleased(
  prismaClient: PrismaWriter,
  opts: {
    freelancerUserId: string;
    eventTitle: string;
    amount: number;
  }
): Promise<void> {
  await createNotification(prismaClient, {
    user_id: opts.freelancerUserId,
    type: NotificationType.ESCROW_RELEASED,
    title: "정산 완료",
    message: `"${opts.eventTitle}" 행사 대금 ${opts.amount.toLocaleString("ko-KR")}원이 정산되었습니다.`,
    link_url: `/freelancer/settlements`,
  });
}
