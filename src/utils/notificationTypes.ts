/**
 * 인앱 알림 타입 상수
 *
 * 새 타입 추가 시 이 파일만 수정하면 됩니다 (OCP).
 * 각 타입은 문자열 리터럴이라 DB 저장 및 프론트 switch 분기에 그대로 사용됩니다.
 */

export const NotificationType = {
  // ── 필수 5종 ────────────────────────────────────────────────
  /** 고객이 예약 요청을 생성했을 때 → 프리랜서에게 */
  BOOKING_REQUESTED: "booking_requested",
  /** 예약이 양측 합의 / 결제 확정으로 confirmed → 고객에게 */
  BOOKING_CONFIRMED: "booking_confirmed",
  /** 토스 결제 승인 완료 → 고객 + 프리랜서에게 */
  PAYMENT_COMPLETED: "payment_completed",
  /** 행사 완료 후 후기 작성 안내 → 양측 */
  REVIEW_REQUESTED: "review_requested",
  /** 계약서 양측 서명 완료 → 양측 */
  CONTRACT_SIGNED: "contract_signed",

  // ── 추가 확장 타입 ───────────────────────────────────────────
  /** 에스크로 대금이 프리랜서에게 정산되었을 때 */
  ESCROW_RELEASED: "escrow_released",
  /** 가격 제안이 도착했을 때 */
  BOOKING_OFFER_RECEIVED: "booking_offer_received",
  /** 가격 제안이 수락되었을 때 */
  BOOKING_OFFER_ACCEPTED: "booking_offer_accepted",
  /** 가격 제안이 거절되었을 때 */
  BOOKING_OFFER_REJECTED: "booking_offer_rejected",
  /** 관리자가 프리랜서를 승인했을 때 */
  FREELANCER_APPROVED: "freelancer_approved",
  /** 관리자가 후보를 추천했을 때 → 고객 */
  RECOMMENDATION_SENT: "recommendation_sent",
  /** AI 단가 분석 완료 → 고객 */
  AI_PRICING_READY: "ai_pricing_ready",
} as const;

export type NotificationTypeValue =
  (typeof NotificationType)[keyof typeof NotificationType];
