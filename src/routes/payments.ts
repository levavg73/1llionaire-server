/**
 * 토스페이먼츠 PG Sandbox 연동 라우트
 *
 * 플로우:
 *  1. POST /api/payments/prepare   — 결제 준비 (orderId 발급)
 *  2. [클라이언트] payment.requestPayment() 호출 → 토스 결제창
 *  3. [토스] successUrl 리다이렉트 (paymentKey, orderId, amount)
 *  4. POST /api/payments/confirm   — 서버에서 토스 승인 API 호출
 *  5. POST /api/payments/cancel    — 결제 취소
 *  6. GET  /api/payments/:bookingId — 결제 내역 조회
 */

import { Router, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../config/database";
import { authenticate } from "../middleware/auth";
import { requireCustomer, requireCustomerOrAdmin } from "../middleware/roles";
import { AuthRequest } from "../types";
import { successResponse, errorResponse } from "../utils/response";

const router = Router();

// ─── 토스 API 헬퍼 ─────────────────────────────────────────────────────────

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

type TossApiException = Error & {
  status?: number;
  data?: TossApiError;
};

function tossAuthHeader(): string {
  const secretKey = process.env.TOSS_SECRET_KEY ?? "";
  if (!secretKey) throw new Error("TOSS_SECRET_KEY 환경변수가 설정되지 않았습니다.");
  // Basic base64(secretKey + ":")
  const encoded = Buffer.from(`${secretKey}:`).toString("base64");
  return `Basic ${encoded}`;
}

function toPrismaJson(data: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue;
}

async function postTossPayment<T extends Record<string, unknown>>(
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`${TOSS_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: tossAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = (await response.json().catch(() => ({}))) as T & TossApiError;

  if (!response.ok) {
    const error = new Error(data.message ?? "토스페이먼츠 API 요청에 실패했습니다.") as TossApiException;
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

// orderId: 결제 고유 ID (최대 64자, 영문+숫자+-_)
function generateOrderId(bookingId: string): string {
  const ts = Date.now().toString(36).toUpperCase();
  const shortId = bookingId.slice(0, 8).toUpperCase();
  return `FREEMIC-${shortId}-${ts}`;
}

// ─── POST /api/payments/prepare ─────────────────────────────────────────────
// 결제 준비: orderId를 발급하고 DB에 READY 상태로 저장

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

      if (booking.booking_status !== "confirmed") {
        return errorResponse(
          res,
          "CONFLICT",
          "예약 확정 상태에서만 결제할 수 있습니다.",
          [],
          409
        );
      }

      if (booking.payment_status === "fully_paid") {
        return errorResponse(res, "CONFLICT", "이미 결제가 완료된 예약입니다.", [], 409);
      }

      // 기존 READY 결제가 있으면 재사용, 없으면 새로 생성
      let payment = await prisma.payment.findUnique({
        where: { booking_id },
      });

      const shouldIssueNewPayment =
        !payment ||
        payment.amount !== booking.final_price ||
        ["ABORTED", "EXPIRED", "CANCELED", "PARTIAL_CANCELED"].includes(payment.status);

      if (shouldIssueNewPayment) {
        const orderId = generateOrderId(booking_id);
        payment = await prisma.payment.upsert({
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
      }

      return successResponse(res, {
        order_id: payment.order_id,
        amount: payment.amount,
        order_name: booking.event_title,
        customer_key: userId,
        client_key: process.env.TOSS_CLIENT_KEY ?? "",
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/payments/confirm ─────────────────────────────────────────────
// 결제 승인: 토스 서버에 confirm 요청 후 DB 업데이트

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

      // DB에서 결제 정보 조회
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

      // 금액 변조 방지
      if (payment.amount !== body.amount) {
        return errorResponse(res, "VALIDATION_ERROR", "결제 금액이 일치하지 않습니다.", [], 400);
      }

      // 이미 승인된 경우에도 성공 응답을 반환하여 성공 페이지 새로고침/중복 요청을 안전하게 처리합니다.
      if (payment.status === "DONE") {
        return successResponse(
          res,
          {
            payment_key: payment.payment_key,
            order_id: payment.order_id,
            amount: payment.amount,
            method: payment.method,
            approved_at: payment.approved_at?.toISOString(),
            status: "DONE",
          },
          "이미 결제가 완료되었습니다."
        );
      }

      // ── 토스 승인 API 호출 ──────────────────────────────────────────────
      let tossData: TossPaymentResponse;
      try {
        tossData = await postTossPayment<TossPaymentResponse>("/confirm", {
          paymentKey: body.payment_key,
          orderId: body.order_id,
          amount: body.amount,
        });
      } catch (tossErr) {
        const tossData = (tossErr as TossApiException).data;

        // 실패 상태로 DB 업데이트
        await prisma.payment.update({
          where: { order_id: body.order_id },
          data: {
            status: "ABORTED",
            failure_code: tossData?.code ?? "UNKNOWN",
            failure_message: tossData?.message ?? "토스페이먼츠 승인 오류",
          },
        });

        return errorResponse(
          res,
          "SERVER_ERROR",
          tossData?.message ?? "결제 승인에 실패했습니다.",
          [],
          500
        );
      }

      // ── DB 트랜잭션: Payment 업데이트 + Booking 결제 상태 변경 ──────────
      await prisma.$transaction([
        prisma.payment.update({
          where: { order_id: body.order_id },
          data: {
            payment_key: tossData.paymentKey,
            status: "DONE",
            method: tossData.method,
            requested_at: tossData.requestedAt ? new Date(tossData.requestedAt) : null,
            approved_at: tossData.approvedAt ? new Date(tossData.approvedAt) : null,
            raw_response: toPrismaJson(tossData),
          },
        }),
        prisma.booking.update({
          where: { id: payment.booking_id },
          data: { payment_status: "fully_paid" },
        }),
      ]);

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

// ─── POST /api/payments/cancel ──────────────────────────────────────────────
// 결제 취소 (전액 취소)

const cancelSchema = z.object({
  booking_id: z.string().min(1),
  cancel_reason: z.string().min(1, "취소 사유를 입력해 주세요."),
  cancel_amount: z.number().int().positive().optional(), // 미입력 시 전액 취소
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

      // ── 토스 취소 API 호출 ──────────────────────────────────────────────
      let tossData: TossPaymentResponse;
      try {
        tossData = await postTossPayment<TossPaymentResponse>(`/${payment.payment_key}/cancel`, {
          cancelReason: body.cancel_reason,
          ...(body.cancel_amount && { cancelAmount: body.cancel_amount }),
        });
      } catch (tossErr) {
        const tossData = (tossErr as TossApiException).data;
        return errorResponse(
          res,
          "SERVER_ERROR",
          tossData?.message ?? "결제 취소에 실패했습니다.",
          [],
          500
        );
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
            booking_status: isFullCancel ? "canceled" : undefined,
            cancel_reason: body.cancel_reason,
          },
        }),
      ]);

      return successResponse(res, { status: isFullCancel ? "CANCELED" : "PARTIAL_CANCELED" }, "결제가 취소되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/payments/:bookingId ────────────────────────────────────────────
// 결제 내역 조회

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
            },
          },
        },
      });

      if (!payment) {
        return errorResponse(res, "NOT_FOUND", "결제 내역을 찾을 수 없습니다.", [], 404);
      }

      // 권한 검증
      if (userType === "customer" && payment.booking.customer_id !== userId) {
        return errorResponse(res, "FORBIDDEN", "접근 권한이 없습니다.", [], 403);
      }

      // raw_response는 응답에서 제외 (내부 민감 정보)
      const { raw_response: _, ...safePayment } = payment;

      return successResponse(res, safePayment);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
