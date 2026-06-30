export type RequestStatus =
  | "submitted"
  | "reviewing"
  | "recommending"
  | "recommended"
  | "consulting"
  | "booked"
  | "completed"
  | "reviewed"
  | "canceled"
  | "disputed";

export type BookingStatus =
  | "pending"
  | "negotiating"
  | "accepted"
  | "rejected"
  | "payment_pending"
  | "confirmed"
  | "completion_requested"
  | "completed"
  | "canceled"
  | "disputed";

export const requestTransitions: Record<RequestStatus, RequestStatus[]> = {
  submitted: ["reviewing", "canceled"],
  reviewing: ["recommending", "canceled", "disputed"],
  recommending: ["recommended", "canceled", "disputed"],
  recommended: ["consulting", "booked", "canceled", "disputed"],
  consulting: ["recommended", "booked", "canceled", "disputed"],
  booked: ["completed", "disputed"],
  completed: ["reviewed"],
  reviewed: [],
  canceled: [],
  disputed: ["canceled"],
};

export const bookingTransitions: Record<BookingStatus, BookingStatus[]> = {
  // 계약 전: 요청 → 수락 → 가격 협상 → 금액 확정/계약서 생성
  pending: ["accepted", "rejected", "canceled", "disputed"],
  accepted: ["negotiating", "canceled", "disputed"],
  negotiating: ["payment_pending", "canceled", "disputed"],

  // 계약서 양측 서명 + 결제 완료 이후에만 confirmed 로 진입합니다.
  payment_pending: ["confirmed", "canceled", "disputed"],

  // 계약/결제 이후에는 일반 취소가 아니라 결제 환불 플로우를 사용합니다.
  confirmed: ["completion_requested", "completed", "disputed"],
  completion_requested: ["completed", "disputed"],

  // 정산까지 끝난 거래는 닫힌 상태입니다.
  completed: [],
  rejected: [],
  canceled: [],
  disputed: ["canceled"],
};

const isRequestStatus = (status: string): status is RequestStatus => {
  return Object.prototype.hasOwnProperty.call(requestTransitions, status);
};

const isBookingStatus = (status: string): status is BookingStatus => {
  return Object.prototype.hasOwnProperty.call(bookingTransitions, status);
};

export const canTransitionRequest = (from: string, to: string): boolean => {
  if (from === to) return true;
  if (!isRequestStatus(from) || !isRequestStatus(to)) return false;
  return requestTransitions[from].includes(to);
};

export const canTransitionBooking = (from: string, to: string): boolean => {
  if (from === to) return true;
  if (!isBookingStatus(from) || !isBookingStatus(to)) return false;
  return bookingTransitions[from].includes(to);
};
