import {
  BookingStatus,
  ContractStatus,
  EscrowStatus,
  PaymentStatus,
  SettlementStatus,
} from "@prisma/client";

export type TransactionDisplayStatus =
  | "contract_pending"
  | "in_progress"
  | "completed"
  | "canceled";

export type BookingLifecycleInput = {
  booking_status: BookingStatus | string;
  payment_status: PaymentStatus | string;
  settlement_status?: SettlementStatus | string | null;
  escrow_status?: EscrowStatus | string | null;
  contract?: { status?: ContractStatus | string | null } | null;
};

const CANCELED_BOOKING_STATUSES = new Set<string>([
  "canceled",
  "rejected",
  "disputed",
]);

const PRE_CONTRACT_BOOKING_STATUSES = new Set<string>([
  "pending",
  "accepted",
  "negotiating",
  "payment_pending",
]);

export function getTransactionDisplayStatus(
  booking: BookingLifecycleInput,
): TransactionDisplayStatus {
  if (
    CANCELED_BOOKING_STATUSES.has(String(booking.booking_status)) ||
    booking.payment_status === "refunded" ||
    booking.escrow_status === "refunded" ||
    booking.contract?.status === "voided"
  ) {
    return "canceled";
  }

  if (
    booking.booking_status === "completed" &&
    booking.payment_status === "fully_paid" &&
    booking.escrow_status === "released" &&
    booking.settlement_status === "completed"
  ) {
    return "completed";
  }

  if (
    booking.contract?.status === "fully_signed" &&
    booking.payment_status === "fully_paid" &&
    booking.escrow_status === "held"
  ) {
    return "in_progress";
  }

  return "contract_pending";
}

export function withTransactionDisplayStatus<T extends BookingLifecycleInput>(
  booking: T,
): T & { transaction_status: TransactionDisplayStatus } {
  return {
    ...booking,
    transaction_status: getTransactionDisplayStatus(booking),
  };
}

export function isContractFullySigned(
  booking: Pick<BookingLifecycleInput, "contract">,
): boolean {
  return booking.contract?.status === "fully_signed";
}

export function canDirectCancelBooking(
  booking: BookingLifecycleInput,
): boolean {
  return (
    PRE_CONTRACT_BOOKING_STATUSES.has(String(booking.booking_status)) &&
    booking.payment_status === "unpaid" &&
    (booking.escrow_status ?? "none") === "none" &&
    !isContractFullySigned(booking)
  );
}

export function canConfirmPaymentAfterContract(
  booking: BookingLifecycleInput,
): boolean {
  return (
    booking.contract?.status === "fully_signed" &&
    ["payment_pending", "confirmed"].includes(String(booking.booking_status)) &&
    booking.payment_status !== "fully_paid" &&
    (booking.escrow_status ?? "none") !== "released"
  );
}

export function canRequestOrApproveCompletion(
  booking: BookingLifecycleInput,
): boolean {
  return (
    ["confirmed", "completion_requested"].includes(
      String(booking.booking_status),
    ) &&
    booking.contract?.status === "fully_signed" &&
    booking.payment_status === "fully_paid" &&
    booking.escrow_status === "held"
  );
}

export function canReleaseEscrow(booking: BookingLifecycleInput): boolean {
  return (
    booking.booking_status === "completed" &&
    booking.contract?.status === "fully_signed" &&
    booking.payment_status === "fully_paid" &&
    booking.escrow_status === "held" &&
    booking.settlement_status !== "completed"
  );
}

export function canRefundPaidBooking(booking: BookingLifecycleInput): boolean {
  return (
    booking.payment_status === "fully_paid" &&
    booking.escrow_status === "held" &&
    booking.settlement_status !== "completed"
  );
}
