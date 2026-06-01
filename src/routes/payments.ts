/**
 * 토스페이먼츠 PG Sandbox 연동 라우트
 *
 * 플로우:
 *  1. POST /api/payments/prepare   - 결제 준비(orderId 발급)
 *  2. 클라이언트에서 Toss Payments 결제창 호출
 *  3. Toss successUrl 리다이렉트(paymentKey, orderId, amount)
 *  4. POST /api/payments/confirm   - 서버에서 Toss 승인 API 호출
 *  5. POST /api/payments/cancel    - 결제 취소
 *  6. GET  /api/payments/:bookingId - 결제 내역 조회
 */

import { Router, Response, NextFunction } from "express";
import axios from "axios";
import { z } from "zod";
import prisma from "../config/database";
import { env } from "../config/env";
import { authenticate } from "../middleware/auth";
import { requireCustomer, requireCustomerOrAdmin } from "../middleware/roles";
import { AuthRequest } from "../types";
import { successResponse, errorResponse } from "../utils/response";
import { createNotification } from "../utils/notifications";
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

type TossApiError = {
  code?: string;
  message?: string;
};

type JsonPrimitive = string | number | boolean;

type JsonInputValue =
  | JsonPrimitive
  | { [key: string]: JsonInputValue | null }
  | Array<JsonInputValue | null>;

function tossAuthHeader(): string {
  const encoded = Buffer.from(`${env.TOSS_SECRET_KEY}:`).toString("base64");
  return `Basic ${encoded}`;
}

function toPrismaJson(data: unknown): JsonInputValue {
  const serialized = JSON.stringify(data);

  if (!serialized) {
    return {};
  }

  const parsed = JSON.parse(serialized) as JsonInputValue | null;

  return parsed ?? {};
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
  const shortId = bookingId.slice(0, 8).toUpperCase();
  return `FREEMIC-${shortId}-${ts}`;
}

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
        where: {
          id: booking_id,
          customer_id: userId,
        },
      });

      if (!booking) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "예약을 찾을 수 없습니다.",
          [],
          404
        );
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
        return errorResponse(
          res,
          "CONFLICT",
          "이미 결제가 완료된 예약입니다.",
          [],
          409
        );
      }

      const orderId = generateOrderId(booking_id);

      const payment = await prisma.payment.upsert({
        where: {
          booking_id,
        },
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

      return successResponse(res, {
        order_id: payment.order_id,
        amount: payment.amount,
        order_name: booking.event_title,
        customer_key: userId,
        client_key: env.TOSS_CLIENT_KEY,
      });
    } catch (err) {
      next(err);
    }
  }
);

const confirmSchema = z.object({
  payment_key: z.string().min(1, "paymentKey가 필요합니다."),
  order_id: z.string().min(1, "orderId가 필요합니다."),
  amount: z.number().int().positive("amount가 필요합니다."),
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
        where: {
          order_id: body.order_id,
        },
        include: {
          booking: true,
        },
      });

      if (!payment) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "결제 정보를 찾을 수 없습니다.",
          [],
          404
        );
      }

      if (payment.booking.customer_id !== userId) {
        return errorResponse(
          res,
          "FORBIDDEN",
          "본인 예약에 대해서만 결제할 수 있습니다.",
          [],
          403
        );
      }

      if (payment.amount !== body.amount) {
        return errorResponse(
          res,
          "VALIDATION_ERROR",
          "결제 금액이 일치하지 않습니다.",
          [],
          400
        );
      }

      if (payment.status === "DONE") {
        return errorResponse(
          res,
          "CONFLICT",
          "이미 승인된 결제입니다.",
          [],
          409
        );
      }

      let tossData: TossPaymentResponse;

      try {
        tossData = await postTossPayment<TossPaymentResponse>(
          `${TOSS_API_BASE}/confirm`,
          {
            paymentKey: body.payment_key,
            orderId: body.order_id,
            amount: body.amount,
          }
        );
      } catch (tossErr) {
        const errData = (tossErr as { response?: { data?: TossApiError } })
          ?.response?.data;

        await prisma.payment.update({
          where: {
            order_id: body.order_id,
          },
          data: {
            status: "ABORTED",
            failure_code: errData?.code ?? "UNKNOWN",
            failure_message: errData?.message ?? "토스페이먼츠 승인 오류",
          },
        });

        return errorResponse(
          res,
          "SERVER_ERROR",
          errData?.message ?? "결제 승인에 실패했습니다.",
          [],
          500
        );
      }

      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: {
            order_id: body.order_id,
          },
          data: {
            payment_key: tossData.paymentKey,
            status: "DONE",
            method: tossData.method,
            requested_at: tossData.requestedAt
              ? new Date(tossData.requestedAt)
              : null,
            approved_at: tossData.approvedAt
              ? new Date(tossData.approvedAt)
              : null,
            raw_response: toPrismaJson(tossData),
          },
        });

        const confirmedBooking = await tx.booking.update({
          where: {
            id: payment.booking_id,
          },
          data: {
            payment_status: "fully_paid",
            booking_status: "confirmed",
          },
          include: {
            freelancer: { select: { user_id: true } },
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

        await createNotification(tx, {
          user_id: confirmedBooking.freelancer.user_id,
          type: "payment_completed",
          title: "결제 완료",
          message: `${confirmedBooking.event_title} 결제가 완료되었습니다.`,
          link_url: `/freelancer/bookings`,
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
        },
        "결제가 완료되었습니다."
      );
    } catch (err) {
      next(err);
    }
  }
);

const cancelSchema = z.object({
  booking_id: z.string().min(1, "예약 ID가 필요합니다."),
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
        where: {
          booking_id: body.booking_id,
        },
        include: {
          booking: true,
        },
      });

      if (!payment || payment.status !== "DONE") {
        return errorResponse(
          res,
          "NOT_FOUND",
          "취소할 수 있는 결제를 찾을 수 없습니다.",
          [],
          404
        );
      }

      if (userType === "customer" && payment.booking.customer_id !== userId) {
        return errorResponse(
          res,
          "FORBIDDEN",
          "접근 권한이 없습니다.",
          [],
          403
        );
      }

      if (!payment.payment_key) {
        return errorResponse(
          res,
          "SERVER_ERROR",
          "paymentKey가 없습니다.",
          [],
          500
        );
      }

      let tossData: Record<string, unknown>;

      try {
        tossData = await postTossPayment<Record<string, unknown>>(
          `${TOSS_API_BASE}/${payment.payment_key}/cancel`,
          {
            cancelReason: body.cancel_reason,
            ...(body.cancel_amount && {
              cancelAmount: body.cancel_amount,
            }),
          }
        );
      } catch (tossErr) {
        const errData = (tossErr as { response?: { data?: TossApiError } })
          ?.response?.data;

        return errorResponse(
          res,
          "SERVER_ERROR",
          errData?.message ?? "결제 취소에 실패했습니다.",
          [],
          500
        );
      }

      const isFullCancel =
        !body.cancel_amount || body.cancel_amount >= payment.amount;

      await prisma.$transaction([
        prisma.payment.update({
          where: {
            booking_id: body.booking_id,
          },
          data: {
            status: isFullCancel ? "CANCELED" : "PARTIAL_CANCELED",
            raw_response: toPrismaJson(tossData),
          },
        }),
        prisma.booking.update({
          where: {
            id: body.booking_id,
          },
          data: {
            payment_status: "refunded",
            ...(isFullCancel && {
              booking_status: "canceled",
            }),
            cancel_reason: body.cancel_reason,
          },
        }),
      ]);

      return successResponse(
        res,
        {
          status: isFullCancel ? "CANCELED" : "PARTIAL_CANCELED",
        },
        "결제가 취소되었습니다."
      );
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/:bookingId",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userType, userId } = req.user!;

      const payment = await prisma.payment.findUnique({
        where: {
          booking_id: req.params.bookingId,
        },
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
            },
          },
        },
      });

      if (!payment) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "결제 내역을 찾을 수 없습니다.",
          [],
          404
        );
      }

      if (userType === "customer" && payment.booking.customer_id !== userId) {
        return errorResponse(
          res,
          "FORBIDDEN",
          "접근 권한이 없습니다.",
          [],
          403
        );
      }

      const { raw_response: _rawResponse, ...safePayment } = payment;

      return successResponse(res, safePayment);
    } catch (err) {
      next(err);
    }
  }
);

export default router;