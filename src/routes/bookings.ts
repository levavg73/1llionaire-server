import { Router, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../config/database";
import { authenticate } from "../middleware/auth";
import { requireCustomer, requireCustomerOrAdmin, requireAdmin } from "../middleware/roles";
import { AuthRequest, AuthPayload } from "../types";
import {
  successResponse,
  errorResponse,
  listResponse,
  parsePagination,
} from "../utils/response";
import { canTransitionBooking, canTransitionRequest } from "../utils/stateTransitions";
import { createNotification, notifyReviewRequested } from "../utils/notifications";
import { attachSignedProfileImageUrl } from "../utils/profileImages";

const router = Router();

const BOOKING_PLATFORM_FEE_RATE = 0.1;
const BLOCKED_BOOKING_REQUEST_STATUSES = ["booked", "completed", "reviewed", "canceled", "disputed"];
const CLOSED_BOOKING_STATUSES = ["rejected", "completed", "canceled", "disputed"];

const createBookingSchema = z.object({
  request_id: z.string().min(1, "요청서를 선택해 주세요."),
  freelancer_id: z.string().min(1, "프리랜서를 선택해 주세요."),
  quote_id: z.string().optional(),
  customer_id: z.string().optional(),
});

const offerSchema = z.object({
  amount: z.number().int().positive("제안 금액을 입력해 주세요."),
  message: z.string().trim().max(1000).optional(),
});

function calculateAmounts(finalPrice: number) {
  const platformFee = Math.floor(finalPrice * BOOKING_PLATFORM_FEE_RATE);
  return {
    finalPrice,
    platformFee,
    freelancerAmount: finalPrice - platformFee,
  };
}

function customerChatLink(roomId: string) {
  return `/customer/chats/${roomId}`;
}

function freelancerChatLink(roomId: string) {
  return `/freelancer/chats/${roomId}`;
}

async function getBookingForUser(bookingId: string, user: AuthPayload) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      request: true,
      customer: { select: { id: true, name: true, email: true } },
      freelancer: {
        select: {
          id: true,
          user_id: true,
          display_name: true,
          profile_image_url: true,
          profile_image_path: true,
        },
      },
      chat_room: true,
      offers: { orderBy: { created_at: "desc" }, take: 5 },
      quote: true,
      reviews: true,
    },
  });

  if (!booking) return null;

  const isOwnerCustomer = user.userType === "customer" && booking.customer_id === user.userId;
  const isOwnerFreelancer = user.userType === "freelancer" && booking.freelancer.user_id === user.userId;
  const isAdmin = user.userType === "admin";

  if (!isOwnerCustomer && !isOwnerFreelancer && !isAdmin) return null;

  return booking;
}

async function serializeBooking<T extends { freelancer?: { profile_image_path?: string | null; profile_image_url?: string | null } | null }>(booking: T) {
  if (!booking.freelancer) return booking;

  return {
    ...booking,
    freelancer: await attachSignedProfileImageUrl(booking.freelancer),
  };
}

// POST /api/bookings - 고객이 프리랜서에게 예약/상담 요청
router.post(
  "/",
  authenticate,
  requireCustomerOrAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = createBookingSchema.parse(req.body);
      const { userType, userId } = req.user!;

      const request = await prisma.eventRequest.findUnique({ where: { id: body.request_id } });

      if (!request) {
        return errorResponse(res, "NOT_FOUND", "요청서를 찾을 수 없습니다.", [], 404);
      }

      if (userType === "customer" && request.customer_id !== userId) {
        return errorResponse(res, "FORBIDDEN", "본인 요청서에 대해서만 예약을 요청할 수 있습니다.", [], 403);
      }

      if (userType === "admin" && body.customer_id && body.customer_id !== request.customer_id) {
        return errorResponse(res, "VALIDATION_ERROR", "customer_id가 요청서 소유자와 일치하지 않습니다.", [], 400);
      }

      if (BLOCKED_BOOKING_REQUEST_STATUSES.includes(request.status)) {
        return errorResponse(res, "CONFLICT", "현재 상태의 요청서에는 예약을 요청할 수 없습니다.", [], 409);
      }

      const existingBooking = await prisma.booking.findFirst({
        where: {
          request_id: body.request_id,
          booking_status: { notIn: ["canceled", "rejected"] },
        },
      });

      if (existingBooking) {
        return errorResponse(res, "CONFLICT", "이미 진행 중인 예약 요청이 있습니다.", [], 409);
      }

      const recommendation = await prisma.recommendation.findFirst({
        where: {
          request_id: body.request_id,
          freelancer_id: body.freelancer_id,
          status: { in: ["sent", "viewed", "consultation_requested", "selected"] },
        },
      });

      if (!recommendation) {
        return errorResponse(res, "FORBIDDEN", "추천된 프리랜서에 대해서만 예약을 요청할 수 있습니다.", [], 403);
      }

      const quote = body.quote_id
        ? await prisma.quote.findFirst({
            where: {
              id: body.quote_id,
              request_id: body.request_id,
              freelancer_id: body.freelancer_id,
              status: { in: ["proposed", "accepted"] },
            },
          })
        : await prisma.quote.findFirst({
            where: {
              request_id: body.request_id,
              freelancer_id: body.freelancer_id,
              status: { in: ["proposed", "accepted"] },
            },
            orderBy: { created_at: "desc" },
          });

      const freelancer = await prisma.freelancerProfile.findUnique({
        where: { id: body.freelancer_id },
        select: { id: true, user_id: true, display_name: true, base_price_min: true, base_price_max: true },
      });

      if (!freelancer) {
        return errorResponse(res, "NOT_FOUND", "프리랜서를 찾을 수 없습니다.", [], 404);
      }

      const fallbackPrice =
        quote?.price ??
        request.budget_max ??
        request.budget_min ??
        freelancer.base_price_min ??
        freelancer.base_price_max;

      if (!fallbackPrice) {
        return errorResponse(res, "VALIDATION_ERROR", "예약 요청을 위해 견적 또는 기준 금액이 필요합니다.", [], 400);
      }

      const amounts = calculateAmounts(fallbackPrice);

      const booking = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const created = await tx.booking.create({
          data: {
            request_id: request.id,
            customer_id: request.customer_id,
            freelancer_id: body.freelancer_id,
            quote_id: quote?.id,
            event_title: request.event_title,
            event_date: request.event_date,
            start_time: request.start_time,
            end_time: request.end_time,
            venue: request.venue,
            final_price: amounts.finalPrice,
            platform_fee: amounts.platformFee,
            freelancer_amount: amounts.freelancerAmount,
            booking_status: "pending",
            payment_status: "unpaid",
            settlement_status: "pending",
          },
        });

        const room = await tx.chatRoom.create({
          data: {
            booking_id: created.id,
            customer_id: request.customer_id,
            freelancer_id: body.freelancer_id,
            last_message_at: new Date(),
          },
        });

        await tx.chatMessage.create({
          data: {
            room_id: room.id,
            sender_id: null,
            message: "고객이 예약 요청을 보냈습니다. 수락, 거절 또는 가격 제안을 선택해 주세요.",
            message_type: "system",
            is_read: false,
          },
        });

        await tx.eventRequest.update({
          where: { id: request.id },
          data: { status: "consulting" },
        });

        await tx.recommendation.update({
          where: { id: recommendation.id },
          data: { status: "consultation_requested" },
        });

        await createNotification(tx, {
          user_id: freelancer.user_id,
          type: "booking_requested",
          title: "새 예약 요청",
          message: `${request.event_title} 예약 요청이 도착했습니다.`,
          link_url: freelancerChatLink(room.id),
        });

        return tx.booking.findUniqueOrThrow({
          where: { id: created.id },
          include: {
            customer: { select: { id: true, name: true } },
            freelancer: {
              select: { id: true, user_id: true, display_name: true, profile_image_url: true, profile_image_path: true },
            },
            chat_room: true,
            offers: { orderBy: { created_at: "desc" }, take: 5 },
          },
        });
      });

      return successResponse(res, await serializeBooking(booking), "예약 요청을 보냈습니다.", 201);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/bookings
router.get("/", authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
    const { userType, userId } = req.user!;

    let where: Record<string, unknown> = {};

    if (userType === "customer") {
      where = { customer_id: userId };
    } else if (userType === "freelancer") {
      const profile = await prisma.freelancerProfile.findUnique({ where: { user_id: userId } });
      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프로필을 찾을 수 없습니다.", [], 404);
      }
      where = { freelancer_id: profile.id };
    }

    const [items, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        include: {
          customer: { select: { id: true, name: true } },
          freelancer: {
            select: { id: true, user_id: true, display_name: true, profile_image_url: true, profile_image_path: true },
          },
          chat_room: true,
          offers: { orderBy: { created_at: "desc" }, take: 3 },
        },
      }),
      prisma.booking.count({ where }),
    ]);

    const responseItems = await Promise.all(items.map((item) => serializeBooking(item)));

    return listResponse(res, responseItems, total, page, limit);
  } catch (err) {
    next(err);
  }
});

// GET /api/bookings/:id
router.get("/:id", authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const booking = await getBookingForUser(req.params.id, req.user!);

    if (!booking) {
      return errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
    }

    return successResponse(res, await serializeBooking(booking));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/bookings/:id/accept - 프리랜서 수락
router.patch("/:id/accept", authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const booking = await getBookingForUser(req.params.id, req.user!);

    if (!booking) {
      return errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
    }

    if (req.user!.userType !== "freelancer" || booking.freelancer.user_id !== req.user!.userId) {
      return errorResponse(res, "FORBIDDEN", "프리랜서 본인만 수락할 수 있습니다.", [], 403);
    }

    if (CLOSED_BOOKING_STATUSES.includes(booking.booking_status)) {
      return errorResponse(res, "CONFLICT", "현재 상태에서는 예약을 수락할 수 없습니다.", [], 409);
    }

    const chatRoomId = booking.chat_room?.id ?? null;

    const updated = await prisma.$transaction(async (tx) => {
      const accepted = await tx.booking.update({
        where: { id: booking.id },
        data: { booking_status: "payment_pending" },
      });

      if (chatRoomId) {
        await tx.chatMessage.create({
          data: {
            room_id: chatRoomId,
            sender_id: null,
            message: "프리랜서가 예약 요청을 수락했습니다. 고객은 결제를 진행할 수 있습니다.",
            message_type: "system",
          },
        });

        await tx.chatRoom.update({ where: { id: chatRoomId }, data: { last_message_at: new Date() } });

        await createNotification(tx, {
          user_id: booking.customer_id,
          type: "booking_accepted",
          title: "예약 요청 수락",
          message: `${booking.event_title} 예약 요청이 수락되었습니다.`,
          link_url: customerChatLink(chatRoomId),
        });
      }

      return accepted;
    });

    return successResponse(res, updated, "예약 요청을 수락했습니다.");
  } catch (err) {
    next(err);
  }
});

// PATCH /api/bookings/:id/reject - 프리랜서 거절
router.patch("/:id/reject", authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({ reason: z.string().trim().max(500).optional() });
    const { reason } = schema.parse(req.body ?? {});
    const booking = await getBookingForUser(req.params.id, req.user!);

    if (!booking) {
      return errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
    }

    if (req.user!.userType !== "freelancer" || booking.freelancer.user_id !== req.user!.userId) {
      return errorResponse(res, "FORBIDDEN", "프리랜서 본인만 거절할 수 있습니다.", [], 403);
    }

    if (CLOSED_BOOKING_STATUSES.includes(booking.booking_status)) {
      return errorResponse(res, "CONFLICT", "현재 상태에서는 예약을 거절할 수 없습니다.", [], 409);
    }

    const chatRoomId = booking.chat_room?.id ?? null;

    const updated = await prisma.$transaction(async (tx) => {
      const rejected = await tx.booking.update({
        where: { id: booking.id },
        data: { booking_status: "rejected", cancel_reason: reason ?? null },
      });

      if (booking.request_id) {
        await tx.eventRequest.update({ where: { id: booking.request_id }, data: { status: "recommended" } });
      }

      if (chatRoomId) {
        await tx.chatMessage.create({
          data: {
            room_id: chatRoomId,
            sender_id: null,
            message: reason ? `프리랜서가 예약 요청을 거절했습니다. 사유: ${reason}` : "프리랜서가 예약 요청을 거절했습니다.",
            message_type: "system",
          },
        });

        await tx.chatRoom.update({ where: { id: chatRoomId }, data: { last_message_at: new Date() } });

        await createNotification(tx, {
          user_id: booking.customer_id,
          type: "booking_rejected",
          title: "예약 요청 거절",
          message: `${booking.event_title} 예약 요청이 거절되었습니다.`,
          link_url: customerChatLink(chatRoomId),
        });
      }

      return rejected;
    });

    return successResponse(res, updated, "예약 요청을 거절했습니다.");
  } catch (err) {
    next(err);
  }
});

// POST /api/bookings/:id/offers - 가격 제안
router.post("/:id/offers", authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = offerSchema.parse(req.body);
    const booking = await getBookingForUser(req.params.id, req.user!);

    if (!booking || !booking.chat_room) {
      return errorResponse(res, "NOT_FOUND", "예약 또는 상담방을 찾을 수 없습니다.", [], 404);
    }

    if (CLOSED_BOOKING_STATUSES.includes(booking.booking_status) || booking.payment_status === "fully_paid") {
      return errorResponse(res, "CONFLICT", "현재 상태에서는 가격을 제안할 수 없습니다.", [], 409);
    }

    const chatRoomId = booking.chat_room.id;
    const isCustomer = booking.customer_id === req.user!.userId;
    const receiverId = isCustomer ? booking.freelancer.user_id : booking.customer_id;
    const receiverLink = isCustomer ? freelancerChatLink(chatRoomId) : customerChatLink(chatRoomId);

    const offer = await prisma.$transaction(async (tx) => {
      await tx.bookingOffer.updateMany({
        where: { booking_id: booking.id, status: "pending" },
        data: { status: "cancelled" },
      });

      const created = await tx.bookingOffer.create({
        data: {
          booking_id: booking.id,
          sender_id: req.user!.userId,
          receiver_id: receiverId,
          amount: body.amount,
          message: body.message,
          status: "pending",
        },
      });

      await tx.booking.update({ where: { id: booking.id }, data: { booking_status: "negotiating" } });

      await tx.chatMessage.create({
        data: {
          room_id: chatRoomId,
          sender_id: req.user!.userId,
          message: body.message || `${body.amount.toLocaleString("ko-KR")}원을 제안했습니다.`,
          message_type: "offer",
          offer_id: created.id,
        },
      });

      await tx.chatRoom.update({ where: { id: chatRoomId }, data: { last_message_at: new Date() } });

      await createNotification(tx, {
        user_id: receiverId,
        type: "booking_offer",
        title: "가격 제안 도착",
        message: `${body.amount.toLocaleString("ko-KR")}원 가격 제안이 도착했습니다.`,
        link_url: receiverLink,
      });

      return created;
    });

    return successResponse(res, offer, "가격을 제안했습니다.", 201);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/bookings/:id/offers/:offerId/accept
router.patch("/:id/offers/:offerId/accept", authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const booking = await getBookingForUser(req.params.id, req.user!);

    if (!booking || !booking.chat_room) {
      return errorResponse(res, "NOT_FOUND", "예약 또는 상담방을 찾을 수 없습니다.", [], 404);
    }

    const chatRoomId = booking.chat_room.id;

    const offer = await prisma.bookingOffer.findFirst({
      where: { id: req.params.offerId, booking_id: booking.id, status: "pending" },
    });

    if (!offer) {
      return errorResponse(res, "NOT_FOUND", "수락할 수 있는 가격 제안을 찾을 수 없습니다.", [], 404);
    }

    if (offer.receiver_id !== req.user!.userId) {
      return errorResponse(res, "FORBIDDEN", "가격 제안을 받은 사용자만 수락할 수 있습니다.", [], 403);
    }

    const amounts = calculateAmounts(offer.amount);

    const updated = await prisma.$transaction(async (tx) => {
      const acceptedOffer = await tx.bookingOffer.update({
        where: { id: offer.id },
        data: { status: "accepted", responded_at: new Date() },
      });

      await tx.bookingOffer.updateMany({
        where: { booking_id: booking.id, id: { not: offer.id }, status: "pending" },
        data: { status: "cancelled" },
      });

      const changedBooking = await tx.booking.update({
        where: { id: booking.id },
        data: {
          final_price: amounts.finalPrice,
          platform_fee: amounts.platformFee,
          freelancer_amount: amounts.freelancerAmount,
          booking_status: "payment_pending",
        },
      });

      await tx.chatMessage.create({
        data: {
          room_id: chatRoomId,
          sender_id: null,
          message: `${offer.amount.toLocaleString("ko-KR")}원 가격 제안이 수락되었습니다. 고객은 결제를 진행할 수 있습니다.`,
          message_type: "system",
          offer_id: acceptedOffer.id,
        },
      });

      await tx.chatRoom.update({ where: { id: chatRoomId }, data: { last_message_at: new Date() } });

      await createNotification(tx, {
        user_id: offer.sender_id,
        type: "booking_offer_accepted",
        title: "가격 제안 수락",
        message: `${offer.amount.toLocaleString("ko-KR")}원 가격 제안이 수락되었습니다.`,
        link_url: offer.sender_id === booking.customer_id ? customerChatLink(chatRoomId) : freelancerChatLink(chatRoomId),
      });

      return { booking: changedBooking, offer: acceptedOffer };
    });

    return successResponse(res, updated, "가격 제안을 수락했습니다.");
  } catch (err) {
    next(err);
  }
});

// PATCH /api/bookings/:id/offers/:offerId/reject
router.patch("/:id/offers/:offerId/reject", authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const booking = await getBookingForUser(req.params.id, req.user!);

    if (!booking || !booking.chat_room) {
      return errorResponse(res, "NOT_FOUND", "예약 또는 상담방을 찾을 수 없습니다.", [], 404);
    }

    const chatRoomId = booking.chat_room.id;

    const offer = await prisma.bookingOffer.findFirst({
      where: { id: req.params.offerId, booking_id: booking.id, status: "pending" },
    });

    if (!offer) {
      return errorResponse(res, "NOT_FOUND", "거절할 수 있는 가격 제안을 찾을 수 없습니다.", [], 404);
    }

    if (offer.receiver_id !== req.user!.userId) {
      return errorResponse(res, "FORBIDDEN", "가격 제안을 받은 사용자만 거절할 수 있습니다.", [], 403);
    }

    const rejected = await prisma.$transaction(async (tx) => {
      const rejectedOffer = await tx.bookingOffer.update({
        where: { id: offer.id },
        data: { status: "rejected", responded_at: new Date() },
      });

      await tx.chatMessage.create({
        data: {
          room_id: chatRoomId,
          sender_id: null,
          message: `${offer.amount.toLocaleString("ko-KR")}원 가격 제안이 거절되었습니다.`,
          message_type: "system",
          offer_id: rejectedOffer.id,
        },
      });

      await tx.chatRoom.update({ where: { id: chatRoomId }, data: { last_message_at: new Date() } });

      await createNotification(tx, {
        user_id: offer.sender_id,
        type: "booking_offer_rejected",
        title: "가격 제안 거절",
        message: `${offer.amount.toLocaleString("ko-KR")}원 가격 제안이 거절되었습니다.`,
        link_url: offer.sender_id === booking.customer_id ? customerChatLink(chatRoomId) : freelancerChatLink(chatRoomId),
      });

      return rejectedOffer;
    });

    return successResponse(res, rejected, "가격 제안을 거절했습니다.");
  } catch (err) {
    next(err);
  }
});

// PATCH /api/bookings/:id/cancel
router.patch(
  "/:id/cancel",
  authenticate,
  requireCustomerOrAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userType, userId } = req.user!;
      const { cancel_reason } = req.body;

      const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });

      if (!booking) {
        return errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
      }

      if (userType === "customer" && booking.customer_id !== userId) {
        return errorResponse(res, "FORBIDDEN", "접근 권한이 없습니다.", [], 403);
      }

      if (!canTransitionBooking(booking.booking_status, "canceled")) {
        return errorResponse(res, "VALIDATION_ERROR", "현재 상태에서는 예약을 취소할 수 없습니다.", [], 400);
      }

      const updated = await prisma.booking.update({
        where: { id: req.params.id },
        data: { booking_status: "canceled", cancel_reason: cancel_reason || null },
      });

      return successResponse(res, updated, "예약이 취소되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/bookings/:id/complete-by-customer — 고객 직접 행사 완료 확인
router.patch(
  "/:id/complete-by-customer",
  authenticate,
  requireCustomer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const booking = await prisma.booking.findFirst({
        where: { id: req.params.id, customer_id: req.user!.userId },
        include: { freelancer: { select: { user_id: true } } },
      });

      if (!booking) {
        return errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
      }

      if (booking.booking_status !== "confirmed") {
        return errorResponse(res, "CONFLICT", "예약 확정 상태에서만 행사 완료를 확인할 수 있습니다.", [], 409);
      }

      if (booking.payment_status !== "fully_paid") {
        return errorResponse(res, "CONFLICT", "결제 완료 후 행사 완료를 확인할 수 있습니다.", [], 409);
      }

      const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const completed = await tx.booking.update({
          where: { id: req.params.id },
          data: { booking_status: "completed" },
        });

        await notifyReviewRequested(tx, {
          customerUserId: completed.customer_id,
          freelancerUserId: booking.freelancer.user_id,
          eventTitle: completed.event_title,
          bookingId: completed.id,
        });

        return completed;
      });

      return successResponse(res, updated, "행사 완료가 확인되었습니다. 후기를 작성해 주세요.");
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/bookings/:id/complete — 관리자 행사 완료 처리
router.patch(
  "/:id/complete",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const booking = await prisma.booking.findUnique({
        where: { id: req.params.id },
        include: {
          request: true,
          freelancer: { select: { user_id: true } },
        },
      });

      if (!booking) {
        return errorResponse(res, "NOT_FOUND", "예약을 찾을 수 없습니다.", [], 404);
      }

      if (!canTransitionBooking(booking.booking_status, "completed")) {
        return errorResponse(res, "VALIDATION_ERROR", "현재 상태에서는 행사 완료 처리할 수 없습니다.", [], 400);
      }

      const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const completed = await tx.booking.update({
          where: { id: req.params.id },
          data: { booking_status: "completed" },
        });

        if (booking.request && canTransitionRequest(booking.request.status, "completed")) {
          await tx.eventRequest.update({ where: { id: booking.request.id }, data: { status: "completed" } });
        }

        await notifyReviewRequested(tx, {
          customerUserId: completed.customer_id,
          freelancerUserId: booking.freelancer.user_id,
          eventTitle: completed.event_title,
          bookingId: completed.id,
        });

        return completed;
      });

      return successResponse(res, updated, "행사 완료 처리되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

export default router;
