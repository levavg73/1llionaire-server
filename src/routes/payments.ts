/**
 * 토스페이먼츠 PG + 에스크로 정산 라우트
 *
 * 에스크로 플로우:
 *   결제 확인(DONE) → escrow_status=held → 행사 완료 후 N일 → escrow_status=released
 *
 * - POST /api/payments/prepare
 * - POST /api/payments/confirm      → 에스크로 hold
 * - POST /api/payments/cancel
 * - POST /api/payments/escrow/release/:bookingId  → 관리자 수동 정산 릴리즈
 * - GET  /api/payments/:bookingId
 */

import { Router, Response, NextFunction } from "express";
import axios from "axios";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../config/database";
import { requireTossKeys } from "../config/env";
import { authenticate } from "../middleware/auth";
import { requireCustomer, requireCustomerOrAdmin, requireAdmin } from "../middleware/roles";
import { AuthRequest } from "../types";
import { successResponse, errorResponse } from "../utils/response";
import {
  notifyPaymentCompleted,
  notifyEscrowReleased,
} from "../utils/notifications";
import { canTransitionRequest } from "../utils/stateTransitions";

const router = Router();

const TOSS_API_BASE = "https://api.tosspayments.com/v1/payments";

type TossPaymentResponse = {
  paymentKey: string;
  orderId: string;
  totalAmount: number;
  method?: string;
  requestedAt?: string;
  approvedAt?: string;
  [key: string]: unknown;
};

type TossApiError = { code?: string; message?: string };

type JsonPrimitive = string | number | boolean;
type JsonInputValue =
  | JsonPrimitive
  | { [key: string]: JsonInputValue | null }
  | Array<JsonInputValue | null>;

function tossAuthHeader(): string {
  const { secretKey } = requireTossKeys();
  return `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;
}

function toPrismaJson(data: unknown): JsonInputValue {
  const serialized = JSON.stringify(data);
  if (!serialized) return {};
  return (JSON.parse(serialized) as JsonInputValue | null) ?? {};
}

async function postTossPayment<T>(
  url: string,
  body: Record<string, unknown>
): Promise<T> {
  const res = await axios.post<T>(url, body, {
    headers: {
      Authorization: tossAuthHeader(),
      "Content-Type": "application/json",
    },
  });
  return res.data;
}

function generateOrderId(bookingId: string): string {
  const ts = Date.now().toString(36).toUpperCase();
  return `FREEMIC-${bookingId.slice(0, 8).toUpperCase()}-${ts}`;
}

// ─── POST /api/payments/prepare ──────────────────────────────

const prepareSchema = z.object({
  booking_id: z.string().min(1, "예약 ID가 필요합니다."),
});

router.post(
  "/prepare",
  authenticate,
  requireCustomer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { booking_id } = prepareSchema.parse(req.body);
      const userId = req.user!.userId;

      const booking = await prisma.booking.findFirst({
        where: { id: booking_id, customer_id: userId },
      });

      if (!booking) {
        return errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
      }

      if (!["payment_pending", "confirmed"].includes(booking.booking_status)) {
        return errorResponse(
          res,
          "CONFLICT",
          "프리랜서 수락 또는 가격 확정 후 결제할 수 있습니다.",
          [],
          409
        );
      }

      if (booking.payment_status === "fully_paid") {
        return errorResponse(res, "CONFLICT", "이미 결제가 완료된 예약입니다.", [], 409);
      }

      const orderId = generateOrderId(booking_id);

      const payment = await prisma.payment.upsert({
        where: { booking_id },
        update: {
          order_id: orderId,
          amount: booking.final_price,
          status: "READY",
          payment_key: null,
          failure_code: null,
          failure_message: null,
        },
        create: {
          booking_id,
          order_id: orderId,
          amount: booking.final_price,
          status: "READY",
        },
      });

      const { clientKey } = requireTossKeys();

      return successResponse(res, {
        order_id: payment.order_id,
        amount: payment.amount,
        order_name: booking.event_title,
        customer_key: userId,
        client_key: clientKey,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/payments/confirm ───────────────────────────────

const confirmSchema = z.object({
  payment_key: z.string().min(1),
  order_id: z.string().min(1),
  amount: z.number().int().positive(),
});

router.post(
  "/confirm",
  authenticate,
  requireCustomer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = confirmSchema.parse(req.body);
      const userId = req.user!.userId;

      const payment = await prisma.payment.findUnique({
        where: { order_id: body.order_id },
        include: { booking: true },
      });

      if (!payment) {
        return errorResponse(res, "NOT_FOUND", "결제 정보를 찾을 수 없습니다.", [], 404);
      }
      if (payment.booking.customer_id !== userId) {
        return errorResponse(res, "FORBIDDEN", "본인 예약에 대해서만 결제할 수 있습니다.", [], 403);
      }
      if (payment.amount !== body.amount) {
        return errorResponse(res, "VALIDATION_ERROR", "결제 금액이 일치하지 않습니다.", [], 400);
      }
      if (payment.status === "DONE") {
        return errorResponse(res, "CONFLICT", "이미 승인된 결제입니다.", [], 409);
      }

      let tossData: TossPaymentResponse;
      try {
        tossData = await postTossPayment<TossPaymentResponse>(
          `${TOSS_API_BASE}/confirm`,
          { paymentKey: body.payment_key, orderId: body.order_id, amount: body.amount }
        );
      } catch (tossErr) {
        const errData = (tossErr as { response?: { data?: TossApiError } })?.response?.data;
        await prisma.payment.update({
          where: { order_id: body.order_id },
          data: {
            status: "ABORTED",
            failure_code: errData?.code ?? "UNKNOWN",
            failure_message: errData?.message ?? "토스페이먼츠 승인 오류",
          },
        });
        return errorResponse(res, "SERVER_ERROR", errData?.message ?? "결제 승인에 실패했습니다.", [], 500);
      }

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.payment.update({
          where: { order_id: body.order_id },
          data: {
            payment_key: tossData.paymentKey,
            status: "DONE",
            method: tossData.method,
            requested_at: tossData.requestedAt ? new Date(tossData.requestedAt) : null,
            approved_at: tossData.approvedAt ? new Date(tossData.approvedAt) : null,
            raw_response: toPrismaJson(tossData),
          },
        });

        // 에스크로 hold + 결제 상태 갱신
        const confirmedBooking = await tx.booking.update({
          where: { id: payment.booking_id },
          data: {
            payment_status: "fully_paid",
            booking_status: "confirmed",
            escrow_status: "held",
            escrow_held_at: new Date(),
          },
          include: {
            freelancer: { select: { user_id: true } },
            customer: { select: { name: true } },
            request: true,
          },
        });

        if (
          confirmedBooking.request &&
          canTransitionRequest(confirmedBooking.request.status, "booked")
        ) {
          await tx.eventRequest.update({
            where: { id: confirmedBooking.request.id },
            data: { status: "booked" },
          });
        }

        // 결제 완료 알림 (5종 중 3번)
        await notifyPaymentCompleted(tx, {
          customerUserId: confirmedBooking.customer_id,
          freelancerUserId: confirmedBooking.freelancer.user_id,
          eventTitle: confirmedBooking.event_title,
          amount: tossData.totalAmount,
          bookingId: confirmedBooking.id,
        });
      });

      return successResponse(
        res,
        {
          payment_key: tossData.paymentKey,
          order_id: tossData.orderId,
          amount: tossData.totalAmount,
          method: tossData.method,
          approved_at: tossData.approvedAt,
          status: "DONE",
          escrow_status: "held",
        },
        "결제가 완료되었습니다. 에스크로 보관 중입니다."
      );
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/payments/escrow/release/:bookingId ─────────────
// 관리자가 에스크로 대금을 프리랜서에게 정산 처리

router.post(
  "/escrow/release/:bookingId",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const booking = await prisma.booking.findUnique({
        where: { id: req.params.bookingId },
        include: {
          freelancer: { select: { user_id: true } },
        },
      });

      if (!booking) {
        return errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
      }

      if (booking.escrow_status !== "held") {
        return errorResponse(
          res,
          "CONFLICT",
          "에스크로 보관 중인 예약만 정산할 수 있습니다.",
          [],
          409
        );
      }

      if (booking.booking_status !== "completed") {
        return errorResponse(
          res,
          "CONFLICT",
          "행사 완료 처리 후 정산할 수 있습니다.",
          [],
          409
        );
      }

      const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const released = await tx.booking.update({
          where: { id: req.params.bookingId },
          data: {
            escrow_status: "released",
            escrow_released_at: new Date(),
            settlement_status: "completed",
          },
        });

        await notifyEscrowReleased(tx, {
          freelancerUserId: booking.freelancer.user_id,
          eventTitle: booking.event_title,
          amount: booking.freelancer_amount,
        });

        return released;
      });

      return successResponse(res, updated, "에스크로 정산이 완료되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/payments/cancel ───────────────────────────────

const cancelSchema = z.object({
  booking_id: z.string().min(1),
  cancel_reason: z.string().min(1, "취소 사유를 입력해 주세요."),
  cancel_amount: z.number().int().positive().optional(),
});

router.post(
  "/cancel",
  authenticate,
  requireCustomerOrAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = cancelSchema.parse(req.body);
      const { userType, userId } = req.user!;

      const payment = await prisma.payment.findUnique({
        where: { booking_id: body.booking_id },
        include: { booking: true },
      });

      if (!payment || payment.status !== "DONE") {
        return errorResponse(res, "NOT_FOUND", "취소할 수 있는 결제를 찾을 수 없습니다.", [], 404);
      }

      if (userType === "customer" && payment.booking.customer_id !== userId) {
        return errorResponse(res, "FORBIDDEN", "접근 권한이 없습니다.", [], 403);
      }

      if (!payment.payment_key) {
        return errorResponse(res, "SERVER_ERROR", "paymentKey가 없습니다.", [], 500);
      }

      let tossData: Record<string, unknown>;
      try {
        tossData = await postTossPayment<Record<string, unknown>>(
          `${TOSS_API_BASE}/${payment.payment_key}/cancel`,
          {
            cancelReason: body.cancel_reason,
            ...(body.cancel_amount && { cancelAmount: body.cancel_amount }),
          }
        );
      } catch (tossErr) {
        const errData = (tossErr as { response?: { data?: TossApiError } })?.response?.data;
        return errorResponse(res, "SERVER_ERROR", errData?.message ?? "결제 취소에 실패했습니다.", [], 500);
      }

      const isFullCancel = !body.cancel_amount || body.cancel_amount >= payment.amount;

      await prisma.$transaction([
        prisma.payment.update({
          where: { booking_id: body.booking_id },
          data: {
            status: isFullCancel ? "CANCELED" : "PARTIAL_CANCELED",
            raw_response: toPrismaJson(tossData),
          },
        }),
        prisma.booking.update({
          where: { id: body.booking_id },
          data: {
            payment_status: "refunded",
            escrow_status: "refunded",
            ...(isFullCancel && { booking_status: "canceled" }),
            cancel_reason: body.cancel_reason,
          },
        }),
      ]);

      return successResponse(
        res,
        { status: isFullCancel ? "CANCELED" : "PARTIAL_CANCELED" },
        "결제가 취소되었습니다."
      );
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/payments/:bookingId ────────────────────────────

router.get(
  "/:bookingId",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userType, userId } = req.user!;

      const payment = await prisma.payment.findUnique({
        where: { booking_id: req.params.bookingId },
        include: {
          booking: {
            select: {
              id: true,
              event_title: true,
              event_date: true,
              final_price: true,
              customer_id: true,
              booking_status: true,
              payment_status: true,
              escrow_status: true,
              escrow_held_at: true,
              escrow_released_at: true,
            },
          },
        },
      });

      if (!payment) {
        return errorResponse(res, "NOT_FOUND", "결제 내역을 찾을 수 없습니다.", [], 404);
      }

      if (userType === "customer" && payment.booking.customer_id !== userId) {
        return errorResponse(res, "FORBIDDEN", "접근 권한이 없습니다.", [], 403);
      }

      const { raw_response: _raw, ...safePayment } = payment;
      return successResponse(res, safePayment);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
