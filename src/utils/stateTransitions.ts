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
  pending: ["negotiating", "accepted", "rejected", "payment_pending", "canceled", "disputed"],
  negotiating: ["accepted", "rejected", "payment_pending", "canceled", "disputed"],
  accepted: ["payment_pending", "confirmed", "canceled", "disputed"],
  rejected: [],
  payment_pending: ["confirmed", "canceled", "disputed"],
  confirmed: ["completion_requested", "completed", "canceled", "disputed"],
  completion_requested: ["completed", "canceled", "disputed"],
  completed: [],
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
