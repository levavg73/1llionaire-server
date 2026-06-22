/**
 * 계약서 라우터
 *
 * - POST /api/contracts/:bookingId/generate — 계약서 자동 생성
 * - GET  /api/contracts/:bookingId          — 계약서 조회
 * - POST /api/contracts/:bookingId/sign     — 서명
 * - GET  /api/contracts/:bookingId/html     — HTML 렌더링 (PDF 출력용)
 *
 * 서명 방식:
 *   SHA256(userId + "|" + bookingId + "|" + timestamp) → hex 저장
 *   법적 효력보다는 "확인 및 동의" 수준의 MVP 전자서명
 *
 * 보안:
 *   - 예약 당사자(고객/프리랜서)만 접근 가능
 *   - 서명 후 내용 변경 불가
 */

import { Router, Response, NextFunction } from "express";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import prisma from "../config/database";
import { authenticate } from "../middleware/auth";
import { AuthRequest } from "../types";
import { successResponse, errorResponse } from "../utils/response";
import {
  notifyContractSigned,
} from "../utils/notifications";

const router = Router();
router.use(authenticate);

// ─── 계약서 내용 생성 헬퍼 ────────────────────────────────────

interface ContractContent {
  version: "1.0";
  generated_at: string;
  event_title: string;
  event_date: string;
  start_time: string;
  end_time: string;
  venue: string | null;
  customer_name: string;
  customer_email: string;
  freelancer_name: string;
  freelancer_display_name: string;
  final_price: number;
  platform_fee: number;
  freelancer_amount: number;
  script_included: boolean;
  rehearsal_included: boolean;
  travel_included: boolean;
  terms: string[];
}

function buildContractContent(
  booking: {
    event_title: string;
    event_date: Date;
    start_time: string;
    end_time: string;
    venue: string | null;
    final_price: number;
    platform_fee: number;
    freelancer_amount: number;
    quote?: {
      script_included: boolean;
      rehearsal_included: boolean;
      travel_fee_included: boolean;
    } | null;
  },
  customer: { name: string; email: string },
  freelancer: { name: string; display_name: string | null }
): ContractContent {
  return {
    version: "1.0",
    generated_at: new Date().toISOString(),
    event_title: booking.event_title,
    event_date: booking.event_date.toISOString().split("T")[0],
    start_time: booking.start_time,
    end_time: booking.end_time,
    venue: booking.venue,
    customer_name: customer.name,
    customer_email: customer.email,
    freelancer_name: freelancer.name,
    freelancer_display_name: freelancer.display_name ?? freelancer.name,
    final_price: booking.final_price,
    platform_fee: booking.platform_fee,
    freelancer_amount: booking.freelancer_amount,
    script_included: booking.quote?.script_included ?? false,
    rehearsal_included: booking.quote?.rehearsal_included ?? false,
    travel_included: booking.quote?.travel_fee_included ?? false,
    terms: [
      "진행자는 행사 시작 1시간 전까지 현장에 도착해야 합니다.",
      "천재지변, 불가항력으로 인한 행사 취소 시 위약금은 상호 협의합니다.",
      "행사 당일 녹화·촬영은 사전 서면 동의 없이 상업적으로 사용할 수 없습니다.",
      "결제 금액은 에스크로로 보관되며, 행사 완료 후 7일 이내 진행자에게 정산됩니다.",
      "분쟁 발생 시 VOIT 운영팀의 중재를 먼저 요청합니다.",
    ],
  };
}

function buildSignatureHash(
  userId: string,
  bookingId: string,
  timestamp: string
): string {
  return crypto
    .createHash("sha256")
    .update(`${userId}|${bookingId}|${timestamp}`)
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

// ─── 권한 확인 헬퍼 ─────────────────────────────────────────

async function getBookingWithParties(bookingId: string) {
  return prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      customer: { select: { id: true, name: true, email: true } },
      freelancer: {
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      },
      quote: {
        select: {
          script_included: true,
          rehearsal_included: true,
          travel_fee_included: true,
        },
      },
      contract: true,
    },
  });
}

function assertParty(
  userId: string,
  userType: string,
  booking: NonNullable<Awaited<ReturnType<typeof getBookingWithParties>>>
): "customer" | "freelancer" | null {
  if (userType === "admin") return "customer"; // admin은 항상 허용
  if (booking.customer_id === userId) return "customer";
  if (booking.freelancer.user_id === userId) return "freelancer";
  return null;
}

// ─── POST /api/contracts/:bookingId/generate ─────────────────

router.post(
  "/:bookingId/generate",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { bookingId } = req.params;
      const { userId, userType } = req.user!;

      const booking = await getBookingWithParties(bookingId);
      if (!booking) {
        return errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
      }

      const party = assertParty(userId, userType, booking);
      if (!party) {
        return errorResponse(res, "FORBIDDEN", "접근 권한이 없습니다.", [], 403);
      }

      if (booking.contract) {
        return errorResponse(
          res,
          "CONFLICT",
          "이미 계약서가 생성되어 있습니다.",
          [],
          409
        );
      }

      // 계약서는 결제 대기 단계부터 생성 가능
      if (!["payment_pending", "confirmed", "completion_requested", "completed"].includes(booking.booking_status)) {
        return errorResponse(
          res,
          "CONFLICT",
          "결제 대기 또는 예약 확정 후에 계약서를 생성할 수 있습니다.",
          [],
          409
        );
      }

      const content = buildContractContent(
        booking,
        booking.customer,
        { name: booking.freelancer.user.name, display_name: booking.freelancer.display_name }
      );

      const contract = await prisma.contract.create({
        data: {
          booking_id: bookingId,
          content_json: content as unknown as Prisma.InputJsonValue,
          status: "pending_customer",
        },
      });

      return successResponse(res, contract, "계약서가 생성되었습니다.", 201);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/contracts/:bookingId ───────────────────────────

router.get(
  "/:bookingId",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const booking = await getBookingWithParties(req.params.bookingId);
      if (!booking) {
        return errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
      }

      const party = assertParty(req.user!.userId, req.user!.userType, booking);
      if (!party) {
        return errorResponse(res, "FORBIDDEN", "접근 권한이 없습니다.", [], 403);
      }

      if (!booking.contract) {
        return errorResponse(res, "NOT_FOUND", "계약서가 없습니다.", [], 404);
      }

      return successResponse(res, booking.contract);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/contracts/:bookingId/sign ─────────────────────

router.post(
  "/:bookingId/sign",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId, userType } = req.user!;
      const { bookingId } = req.params;

      if (userType === "admin") {
        return errorResponse(res, "FORBIDDEN", "관리자는 계약 당사자 서명을 대신할 수 없습니다.", [], 403);
      }

      const booking = await getBookingWithParties(bookingId);
      if (!booking) {
        return errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
      }

      const party = assertParty(userId, userType, booking);
      if (!party || party === null) {
        return errorResponse(res, "FORBIDDEN", "접근 권한이 없습니다.", [], 403);
      }

      const contract = booking.contract;
      if (!contract) {
        return errorResponse(res, "NOT_FOUND", "계약서가 없습니다.", [], 404);
      }

      if (contract.status === "fully_signed") {
        return errorResponse(
          res,
          "CONFLICT",
          "이미 양측 서명이 완료된 계약서입니다.",
          [],
          409
        );
      }

      if (contract.status === "voided") {
        return errorResponse(
          res,
          "CONFLICT",
          "무효화된 계약서입니다.",
          [],
          409
        );
      }

      const timestamp = new Date().toISOString();
      const signatureHash = buildSignatureHash(userId, bookingId, timestamp);

      // 이미 서명했는지 확인
      if (party === "customer" && contract.customer_signed_at) {
        return errorResponse(
          res,
          "CONFLICT",
          "이미 서명하셨습니다.",
          [],
          409
        );
      }
      if (party === "freelancer" && contract.freelancer_signed_at) {
        return errorResponse(
          res,
          "CONFLICT",
          "이미 서명하셨습니다.",
          [],
          409
        );
      }

      const isCustomer = party === "customer";
      const otherAlreadySigned = isCustomer
        ? !!contract.freelancer_signed_at
        : !!contract.customer_signed_at;

      const newStatus = otherAlreadySigned ? "fully_signed" : (
        isCustomer ? "pending_freelancer" : "pending_customer"
      );

      const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const updatedContract = await tx.contract.update({
          where: { id: contract.id },
          data: {
            ...(isCustomer
              ? {
                  customer_signed_at: new Date(timestamp),
                  customer_signature_hash: signatureHash,
                }
              : {
                  freelancer_signed_at: new Date(timestamp),
                  freelancer_signature_hash: signatureHash,
                }),
            status: newStatus,
            ...(newStatus === "fully_signed"
              ? { fully_signed_at: new Date(timestamp) }
              : {}),
          },
        });

        // 양측 서명 완료 시 알림
        if (newStatus === "fully_signed") {
          await notifyContractSigned(tx, {
            customerUserId: booking.customer_id,
            freelancerUserId: booking.freelancer.user_id,
            eventTitle: booking.event_title,
            bookingId: bookingId, // [FIX] contractId → bookingId
          });
        }

        return updatedContract;
      });

      const message =
        newStatus === "fully_signed"
          ? "양측 서명이 완료되었습니다."
          : "서명이 완료되었습니다. 상대방의 서명을 기다리고 있습니다.";

      return successResponse(res, updated, message);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/contracts/:bookingId/html ──────────────────────
// 프론트에서 window.print()로 PDF 저장 가능

router.get(
  "/:bookingId/html",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const booking = await getBookingWithParties(req.params.bookingId);
      if (!booking?.contract) {
        return errorResponse(res, "NOT_FOUND", "계약서를 찾을 수 없습니다.", [], 404);
      }

      const party = assertParty(req.user!.userId, req.user!.userType, booking);
      if (!party) {
        return errorResponse(res, "FORBIDDEN", "접근 권한이 없습니다.", [], 403);
      }

      const c = booking.contract.content_json as unknown as ContractContent;
      const contract = booking.contract;

      const contractTitle = escapeHtml(c.event_title);
      const customerLabel = `${escapeHtml(c.customer_name)} (${escapeHtml(c.customer_email)})`;
      const freelancerLabel = `${escapeHtml(c.freelancer_display_name)} (${escapeHtml(c.freelancer_name)})`;
      const termsHtml = Array.isArray(c.terms)
        ? c.terms.map((term) => `<li>${escapeHtml(term)}</li>`).join("")
        : "";
      const customerSignatureHtml = contract.customer_signed_at
        ? `<p>✅ 서명 완료</p><p class="sig-label">${formatKoDateTime(contract.customer_signed_at)}</p><p class="sig-label" style="word-break:break-all;font-size:10px;">Hash: ${escapeHtml(contract.customer_signature_hash)}</p>`
        : "<p style='color:#999'>서명 대기 중</p>";
      const freelancerSignatureHtml = contract.freelancer_signed_at
        ? `<p>✅ 서명 완료</p><p class="sig-label">${formatKoDateTime(contract.freelancer_signed_at)}</p><p class="sig-label" style="word-break:break-all;font-size:10px;">Hash: ${escapeHtml(contract.freelancer_signature_hash)}</p>`
        : "<p style='color:#999'>서명 대기 중</p>";

      const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>행사 진행 계약서 - ${contractTitle}</title>
<style>
  body { font-family: "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; max-width: 800px; margin: 40px auto; color: #111; line-height: 1.7; }
  h1 { text-align: center; border-bottom: 2px solid #111; padding-bottom: 12px; }
  h2 { margin-top: 32px; font-size: 16px; border-left: 4px solid #2DD4BF; padding-left: 10px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td { border: 1px solid #ccc; padding: 8px 12px; text-align: left; font-size: 14px; }
  th { background: #f5f5f5; width: 30%; }
  .term-list { padding-left: 20px; }
  .term-list li { margin-bottom: 6px; font-size: 14px; }
  .sig-table td { height: 80px; vertical-align: top; }
  .sig-label { font-size: 12px; color: #666; }
  @media print { body { margin: 20px; } }
</style>
</head>
<body>
<h1>행사 진행 계약서</h1>
<p style="text-align:center;color:#666;font-size:13px;">계약 생성일: ${formatKoDate(c.generated_at)}</p>

<h2>1. 계약 당사자</h2>
<table>
  <tr><th>의뢰인(고객)</th><td>${customerLabel}</td></tr>
  <tr><th>수임인(진행자)</th><td>${freelancerLabel}</td></tr>
</table>

<h2>2. 행사 정보</h2>
<table>
  <tr><th>행사명</th><td>${contractTitle}</td></tr>
  <tr><th>행사 일자</th><td>${escapeHtml(c.event_date)}</td></tr>
  <tr><th>진행 시간</th><td>${escapeHtml(c.start_time)} ~ ${escapeHtml(c.end_time)}</td></tr>
  <tr><th>장소</th><td>${escapeHtml(c.venue ?? "미정")}</td></tr>
</table>

<h2>3. 계약 금액</h2>
<table>
  <tr><th>총 결제 금액</th><td>${c.final_price.toLocaleString("ko-KR")}원</td></tr>
  <tr><th>플랫폼 수수료</th><td>${c.platform_fee.toLocaleString("ko-KR")}원</td></tr>
  <tr><th>진행자 수령 금액</th><td>${c.freelancer_amount.toLocaleString("ko-KR")}원</td></tr>
</table>

<h2>4. 포함 서비스</h2>
<table>
  <tr><th>대본 작성</th><td>${c.script_included ? "포함" : "미포함"}</td></tr>
  <tr><th>리허설</th><td>${c.rehearsal_included ? "포함" : "미포함"}</td></tr>
  <tr><th>출장비</th><td>${c.travel_included ? "포함" : "미포함"}</td></tr>
</table>

<h2>5. 계약 조건</h2>
<ul class="term-list">
  ${termsHtml}
</ul>

<h2>6. 서명</h2>
<table class="sig-table">
  <tr>
    <th>의뢰인 서명</th>
    <th>진행자 서명</th>
  </tr>
  <tr>
    <td>
      ${customerSignatureHtml}
    </td>
    <td>
      ${freelancerSignatureHtml}
    </td>
  </tr>
</table>

<p style="margin-top:40px;font-size:12px;color:#999;text-align:center;">
  본 계약서는 VOIT 플랫폼을 통해 자동 생성되었습니다.
</p>
</body>
</html>`;

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      );
      return res.send(html);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
