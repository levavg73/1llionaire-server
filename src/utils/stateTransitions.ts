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

export type BookingStatus = "pending" | "confirmed" | "completed" | "canceled" | "disputed";

export const requestTransitions: Record<RequestStatus, RequestStatus[]> = {
  submitted: ["reviewing", "canceled"],
  reviewing: ["recommending", "canceled", "disputed"],
  recommending: ["recommended", "canceled", "disputed"],
  recommended: ["consulting", "booked", "canceled", "disputed"],
  consulting: ["booked", "canceled", "disputed"],
  booked: ["completed", "disputed"],
  completed: ["reviewed"],
  reviewed: [],
  canceled: [],
  disputed: ["canceled"],
};

export const bookingTransitions: Record<BookingStatus, BookingStatus[]> = {
  pending: ["confirmed", "canceled", "disputed"],
  confirmed: ["completed", "canceled", "disputed"],
  completed: [],
  canceled: [],
  disputed: ["canceled"],
};

export const canTransitionRequest = (from: RequestStatus, to: RequestStatus): boolean => {
  return from === to || requestTransitions[from].includes(to);
};

export const canTransitionBooking = (from: BookingStatus, to: BookingStatus): boolean => {
  return from === to || bookingTransitions[from].includes(to);
};
