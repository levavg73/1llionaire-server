import { Router, Response, NextFunction } from "express";
import { Prisma, BookingStatus } from "@prisma/client";
import { z } from "zod";
import prisma from "../config/database";
import { authenticate } from "../middleware/auth";
import {
  requireCustomer,
  requireCustomerOrAdmin,
  requireAdmin,
} from "../middleware/roles";
import { AuthRequest, AuthPayload } from "../types";
import {
  successResponse,
  errorResponse,
  listResponse,
  parsePagination,
} from "../utils/response";
import {
  canTransitionBooking,
  canTransitionRequest,
} from "../utils/stateTransitions";
import {
  canDirectCancelBooking,
  canRequestOrApproveCompletion,
  withTransactionDisplayStatus,
} from "../utils/bookingLifecycle";
import {
  createNotification,
  notifyReviewRequested,
} from "../utils/notifications";
import { attachSignedProfileImageUrl } from "../utils/profileImages";

const router = Router();

const BOOKING_PLATFORM_FEE_RATE = 0.1;
const BLOCKED_BOOKING_REQUEST_STATUSES = [
  "booked",
  "completed",
  "reviewed",
  "canceled",
  "disputed",
];
const CLOSED_BOOKING_STATUSES = [
  "rejected",
  "completed",
  "canceled",
  "disputed",
];
const BOOKING_STATUS_COMPLETION_REQUESTED =
  "completion_requested" as unknown as BookingStatus;

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

async function createPendingContractForBooking(
  tx: Prisma.TransactionClient,
  bookingId: string,
) {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    include: {
      customer: { select: { name: true, email: true } },
      freelancer: {
        include: {
          user: { select: { name: true, email: true } },
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

  if (!booking || booking.contract) {
    return booking?.contract ?? null;
  }

  const contractContent = {
    version: "1.0",
    generated_at: new Date().toISOString(),
    event_title: booking.event_title,
    event_date: booking.event_date.toISOString().split("T")[0],
    start_time: booking.start_time,
    end_time: booking.end_time,
    venue: booking.venue ?? null,
    customer_name: booking.customer.name,
    customer_email: booking.customer.email,
    freelancer_name: booking.freelancer.user.name,
    freelancer_email: booking.freelancer.user.email,
    freelancer_display_name:
      booking.freelancer.display_name ?? booking.freelancer.user.name,
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
      "결제 금액은 PG sandbox 결제 및 플랫폼 상태값으로 에스크로 보관 흐름을 검증하며, 실서비스에서는 PG사의 구매안전/에스크로 정책을 따릅니다.",
      "양측 전자서명이 완료된 계약서는 직접 수정할 수 없으며, 변경이나 취소가 필요한 경우 환불/계약 무효화 절차를 통해 처리합니다.",
      "분쟁 발생 시 VOIT 운영팀의 중재를 먼저 요청합니다.",
    ],
  };

  return tx.contract.create({
    data: {
      booking_id: booking.id,
      content_json: contractContent as unknown as Prisma.InputJsonValue,
      status: "pending_customer",
    },
  });
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
      contract: {
        select: {
          id: true,
          status: true,
          customer_signed_at: true,
          freelancer_signed_at: true,
          fully_signed_at: true,
        },
      },
    },
  });

  if (!booking) return null;

  const isOwnerCustomer =
    user.userType === "customer" && booking.customer_id === user.userId;
  const isOwnerFreelancer =
    user.userType === "freelancer" &&
    booking.freelancer.user_id === user.userId;
  const isAdmin = user.userType === "admin";

  if (!isOwnerCustomer && !isOwnerFreelancer && !isAdmin) return null;

  return booking;
}

async function serializeBooking<
  T extends {
    booking_status: string;
    payment_status: string;
    settlement_status?: string | null;
    escrow_status?: string | null;
    contract?: { status?: string | null } | null;
    freelancer?: {
      profile_image_path?: string | null;
      profile_image_url?: string | null;
    } | null;
  },
>(booking: T) {
  const bookingWithStatus = withTransactionDisplayStatus(booking);

  if (!booking.freelancer) return bookingWithStatus;

  return {
    ...bookingWithStatus,
    freelancer: await attachSignedProfileImageUrl(booking.freelancer),
  };
}

function isContractLocked(contract?: { status?: string | null } | null) {
  return contract?.status === "fully_signed";
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

      const request = await prisma.eventRequest.findUnique({
        where: { id: body.request_id },
      });

      if (!request) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "요청서를 찾을 수 없습니다.",
          [],
          404,
        );
      }

      if (userType === "customer" && request.customer_id !== userId) {
        return errorResponse(
          res,
          "FORBIDDEN",
          "본인 요청서에 대해서만 예약을 요청할 수 있습니다.",
          [],
          403,
        );
      }

      if (
        userType === "admin" &&
        body.customer_id &&
        body.customer_id !== request.customer_id
      ) {
        return errorResponse(
          res,
          "VALIDATION_ERROR",
          "customer_id가 요청서 소유자와 일치하지 않습니다.",
          [],
          400,
        );
      }

      if (BLOCKED_BOOKING_REQUEST_STATUSES.includes(request.status)) {
        return errorResponse(
          res,
          "CONFLICT",
          "현재 상태의 요청서에는 예약을 요청할 수 없습니다.",
          [],
          409,
        );
      }

      const existingBooking = await prisma.booking.findFirst({
        where: {
          request_id: body.request_id,
          booking_status: { notIn: ["canceled", "rejected"] },
        },
      });

      if (existingBooking) {
        return errorResponse(
          res,
          "CONFLICT",
          "이미 진행 중인 예약 요청이 있습니다.",
          [],
          409,
        );
      }

      const recommendation = await prisma.recommendation.findFirst({
        where: {
          request_id: body.request_id,
          freelancer_id: body.freelancer_id,
          status: {
            in: ["sent", "viewed", "consultation_requested", "selected"],
          },
        },
      });

      if (!recommendation) {
        return errorResponse(
          res,
          "FORBIDDEN",
          "추천된 프리랜서에 대해서만 예약을 요청할 수 있습니다.",
          [],
          403,
        );
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
        select: {
          id: true,
          user_id: true,
          display_name: true,
          base_price_min: true,
          base_price_max: true,
        },
      });

      if (!freelancer) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "프리랜서를 찾을 수 없습니다.",
          [],
          404,
        );
      }

      const fallbackPrice =
        quote?.price ??
        request.budget_max ??
        request.budget_min ??
        freelancer.base_price_min ??
        freelancer.base_price_max;

      if (!fallbackPrice) {
        return errorResponse(
          res,
          "VALIDATION_ERROR",
          "예약 요청을 위해 견적 또는 기준 금액이 필요합니다.",
          [],
          400,
        );
      }

      const amounts = calculateAmounts(fallbackPrice);

      const booking = await prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
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

          // 고객이 진행자를 선택한 직후에는 아직 프리랜서가 수락하지 않았으므로
          // 요청서 전체 상태를 상담 진행 중으로 바꾸지 않습니다.
          // 실제 상담 전환은 프리랜서가 /accept 를 호출해 채팅방이 생성되는 시점에만 발생합니다.
          await tx.recommendation.update({
            where: { id: recommendation.id },
            data: { status: "consultation_requested" },
          });

          await createNotification(tx, {
            user_id: freelancer.user_id,
            type: "booking_requested",
            title: "새 진행 요청",
            message: `${request.event_title} 요청서가 도착했습니다. 요청서를 확인한 뒤 수락 또는 거절해 주세요.`,
            link_url: "/freelancer/requests",
          });

          return tx.booking.findUniqueOrThrow({
            where: { id: created.id },
            include: {
              customer: { select: { id: true, name: true } },
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
            },
          });
        },
      );

      return successResponse(
        res,
        await serializeBooking(booking),
        "진행자에게 요청서를 전달했습니다.",
        201,
      );
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/bookings
router.get(
  "/",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip } = parsePagination(
        req.query as Record<string, unknown>,
      );
      const { userType, userId } = req.user!;

      let where: Record<string, unknown> = {};

      if (userType === "customer") {
        where = { customer_id: userId };
      } else if (userType === "freelancer") {
        const profile = await prisma.freelancerProfile.findUnique({
          where: { user_id: userId },
        });
        if (!profile) {
          return errorResponse(
            res,
            "NOT_FOUND",
            "프로필을 찾을 수 없습니다.",
            [],
            404,
          );
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
              select: {
                id: true,
                user_id: true,
                display_name: true,
                profile_image_url: true,
                profile_image_path: true,
              },
            },
            chat_room: true,
            offers: { orderBy: { created_at: "desc" }, take: 3 },
            contract: {
              select: {
                id: true,
                status: true,
                customer_signed_at: true,
                freelancer_signed_at: true,
                fully_signed_at: true,
              },
            },
          },
        }),
        prisma.booking.count({ where }),
      ]);

      const responseItems = await Promise.all(
        items.map((item) => serializeBooking(item)),
      );

      return listResponse(res, responseItems, total, page, limit);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/bookings/:id
router.get(
  "/:id",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const booking = await getBookingForUser(req.params.id, req.user!);

      if (!booking) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "예약을 찾을 수 없습니다.",
          [],
          404,
        );
      }

      return successResponse(res, await serializeBooking(booking));
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/bookings/:id/accept - 프리랜서 수락
router.patch(
  "/:id/accept",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const booking = await getBookingForUser(req.params.id, req.user!);

      if (!booking) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "예약을 찾을 수 없습니다.",
          [],
          404,
        );
      }

      if (
        req.user!.userType !== "freelancer" ||
        booking.freelancer.user_id !== req.user!.userId
      ) {
        return errorResponse(
          res,
          "FORBIDDEN",
          "프리랜서 본인만 수락할 수 있습니다.",
          [],
          403,
        );
      }

      if (booking.booking_status !== "pending") {
        if (booking.booking_status === "accepted") {
          return successResponse(
            res,
            await serializeBooking(booking),
            "이미 수락된 요청입니다.",
          );
        }

        return errorResponse(
          res,
          "CONFLICT",
          "수락 대기 상태의 요청만 수락할 수 있습니다.",
          [],
          409,
        );
      }

      const updated = await prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: booking.id },
          data: { booking_status: "accepted" },
        });

        const room = booking.chat_room?.id
          ? await tx.chatRoom.update({
              where: { id: booking.chat_room.id },
              data: { last_message_at: new Date() },
            })
          : await tx.chatRoom.create({
              data: {
                booking_id: booking.id,
                customer_id: booking.customer_id,
                freelancer_id: booking.freelancer_id,
                last_message_at: new Date(),
              },
            });

        await tx.chatMessage.create({
          data: {
            room_id: room.id,
            sender_id: null,
            message:
              "진행자가 요청서를 수락했습니다. 이제 상담과 가격 조율을 시작할 수 있습니다.",
            message_type: "system",
          },
        });

        if (booking.request_id) {
          await tx.eventRequest.update({
            where: { id: booking.request_id },
            data: { status: "consulting" },
          });

          await tx.recommendation.updateMany({
            where: {
              request_id: booking.request_id,
              freelancer_id: booking.freelancer_id,
              status: { in: ["consultation_requested", "sent", "viewed", "selected"] },
            },
            data: { status: "selected" },
          });

          const otherRecs = await tx.recommendation.findMany({
            where: {
              request_id: booking.request_id,
              freelancer_id: { not: booking.freelancer_id },
              status: {
                in: ["draft", "sent", "viewed", "consultation_requested"],
              },
            },
            include: { freelancer: { select: { user_id: true } } },
          });

          if (otherRecs.length > 0) {
            await tx.recommendation.updateMany({
              where: {
                request_id: booking.request_id,
                freelancer_id: { not: booking.freelancer_id },
                status: {
                  in: ["draft", "sent", "viewed", "consultation_requested"],
                },
              },
              data: { status: "rejected" },
            });

            await Promise.all(
              otherRecs.map((rec) =>
                createNotification(tx, {
                  user_id: rec.freelancer.user_id,
                  type: "recommendation_auto_rejected",
                  title: "후보 미선택 안내",
                  message: `"${booking.event_title}" 요청서에서 다른 진행자가 최종 수락되어 자동으로 거절 처리되었습니다.`,
                  link_url: "/freelancer/requests",
                }),
              ),
            );
          }
        }

        await createNotification(tx, {
          user_id: booking.customer_id,
          type: "booking_accepted",
          title: "진행 요청 수락",
          message: `${booking.event_title} 진행 요청이 수락되었습니다. 상담을 시작해 주세요.`,
          link_url: customerChatLink(room.id),
        });

        return tx.booking.findUniqueOrThrow({
          where: { id: booking.id },
          include: {
            customer: { select: { id: true, name: true } },
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
            contract: {
              select: {
                id: true,
                status: true,
                customer_signed_at: true,
                freelancer_signed_at: true,
                fully_signed_at: true,
              },
            },
          },
        });
      });

      return successResponse(
        res,
        await serializeBooking(updated),
        "진행 요청을 수락했습니다. 상담방이 열렸습니다.",
      );
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/bookings/:id/reject - 프리랜서 거절
router.patch(
  "/:id/reject",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const schema = z.object({
        reason: z.string().trim().max(500).optional(),
      });
      const { reason } = schema.parse(req.body ?? {});
      const booking = await getBookingForUser(req.params.id, req.user!);

      if (!booking) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "예약을 찾을 수 없습니다.",
          [],
          404,
        );
      }

      if (
        req.user!.userType !== "freelancer" ||
        booking.freelancer.user_id !== req.user!.userId
      ) {
        return errorResponse(
          res,
          "FORBIDDEN",
          "프리랜서 본인만 거절할 수 있습니다.",
          [],
          403,
        );
      }

      if (CLOSED_BOOKING_STATUSES.includes(booking.booking_status)) {
        return errorResponse(
          res,
          "CONFLICT",
          "현재 상태에서는 예약을 거절할 수 없습니다.",
          [],
          409,
        );
      }

      const chatRoomId = booking.chat_room?.id ?? null;

      const updated = await prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: booking.id },
          data: { booking_status: "rejected", cancel_reason: reason ?? null },
        });

        if (booking.request_id) {
          await tx.eventRequest.update({
            where: { id: booking.request_id },
            data: { status: "recommended" },
          });

          await tx.recommendation.updateMany({
            where: {
              request_id: booking.request_id,
              freelancer_id: booking.freelancer_id,
              status: {
                in: ["consultation_requested", "selected", "sent", "viewed"],
              },
            },
            data: { status: "rejected" },
          });
        }

        if (chatRoomId) {
          await tx.chatMessage.create({
            data: {
              room_id: chatRoomId,
              sender_id: null,
              message: reason
                ? `진행자가 요청을 거절했습니다. 사유: ${reason}`
                : "진행자가 요청을 거절했습니다.",
              message_type: "system",
            },
          });

          await tx.chatRoom.update({
            where: { id: chatRoomId },
            data: { last_message_at: new Date() },
          });
        }

        await createNotification(tx, {
          user_id: booking.customer_id,
          type: "booking_rejected",
          title: "진행 요청 거절",
          message: `${booking.event_title} 진행 요청이 거절되었습니다.`,
          link_url: booking.request_id
            ? `/customer/requests/${booking.request_id}/recommendations`
            : "/customer/bookings",
        });

        return tx.booking.findUniqueOrThrow({
          where: { id: booking.id },
          include: {
            customer: { select: { id: true, name: true } },
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
            contract: {
              select: {
                id: true,
                status: true,
                customer_signed_at: true,
                freelancer_signed_at: true,
                fully_signed_at: true,
              },
            },
          },
        });
      });

      return successResponse(
        res,
        await serializeBooking(updated),
        "진행 요청을 거절했습니다.",
      );
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/bookings/:id/offers - 가격 제안
router.post(
  "/:id/offers",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = offerSchema.parse(req.body);
      const booking = await getBookingForUser(req.params.id, req.user!);

      if (!booking || !booking.chat_room) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "예약 또는 상담방을 찾을 수 없습니다.",
          [],
          404,
        );
      }

      if (
        CLOSED_BOOKING_STATUSES.includes(booking.booking_status) ||
        booking.payment_status === "fully_paid"
      ) {
        return errorResponse(
          res,
          "CONFLICT",
          "현재 상태에서는 가격을 제안할 수 없습니다.",
          [],
          409,
        );
      }

      if (booking.booking_status === "pending") {
        return errorResponse(
          res,
          "CONFLICT",
          "진행자가 요청을 수락한 뒤 상담과 가격 제안을 시작할 수 있습니다.",
          [],
          409,
        );
      }

      if (isContractLocked(booking.contract)) {
        return errorResponse(
          res,
          "CONFLICT",
          "양측 서명이 완료된 계약서는 수정할 수 없습니다. 변경이나 취소가 필요하면 환불/계약 무효화 절차를 진행해 주세요.",
          [],
          409,
        );
      }

      const chatRoomId = booking.chat_room.id;
      const isCustomer = booking.customer_id === req.user!.userId;
      const receiverId = isCustomer
        ? booking.freelancer.user_id
        : booking.customer_id;
      const receiverLink = isCustomer
        ? freelancerChatLink(chatRoomId)
        : customerChatLink(chatRoomId);

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

        await tx.booking.update({
          where: { id: booking.id },
          data: { booking_status: "negotiating" },
        });

        await tx.chatMessage.create({
          data: {
            room_id: chatRoomId,
            sender_id: req.user!.userId,
            message:
              body.message ||
              `${body.amount.toLocaleString("ko-KR")}원을 제안했습니다.`,
            message_type: "offer",
            offer_id: created.id,
          },
        });

        await tx.chatRoom.update({
          where: { id: chatRoomId },
          data: { last_message_at: new Date() },
        });

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
  },
);

// PATCH /api/bookings/:id/offers/:offerId/accept
router.patch(
  "/:id/offers/:offerId/accept",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const booking = await getBookingForUser(req.params.id, req.user!);

      if (!booking || !booking.chat_room) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "예약 또는 상담방을 찾을 수 없습니다.",
          [],
          404,
        );
      }

      if (isContractLocked(booking.contract)) {
        return errorResponse(
          res,
          "CONFLICT",
          "양측 서명이 완료된 계약서는 수정할 수 없습니다. 변경이나 취소가 필요하면 환불/계약 무효화 절차를 진행해 주세요.",
          [],
          409,
        );
      }

      const chatRoomId = booking.chat_room.id;

      const offer = await prisma.bookingOffer.findFirst({
        where: {
          id: req.params.offerId,
          booking_id: booking.id,
          status: "pending",
        },
      });

      if (!offer) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "수락할 수 있는 가격 제안을 찾을 수 없습니다.",
          [],
          404,
        );
      }

      if (offer.receiver_id !== req.user!.userId) {
        return errorResponse(
          res,
          "FORBIDDEN",
          "가격 제안을 받은 사용자만 수락할 수 있습니다.",
          [],
          403,
        );
      }

      const amounts = calculateAmounts(offer.amount);

      const updated = await prisma.$transaction(async (tx) => {
        const acceptedOffer = await tx.bookingOffer.update({
          where: { id: offer.id },
          data: { status: "accepted", responded_at: new Date() },
        });

        await tx.bookingOffer.updateMany({
          where: {
            booking_id: booking.id,
            id: { not: offer.id },
            status: "pending",
          },
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

        const contract = await createPendingContractForBooking(tx, booking.id);

        await tx.chatMessage.create({
          data: {
            room_id: chatRoomId,
            sender_id: null,
            message: `${offer.amount.toLocaleString("ko-KR")}원 가격 제안이 수락되었습니다. 계약서가 생성되었습니다. 양측 서명 후 고객은 결제를 진행할 수 있습니다.`,
            message_type: "system",
            offer_id: acceptedOffer.id,
          },
        });

        await tx.chatRoom.update({
          where: { id: chatRoomId },
          data: { last_message_at: new Date() },
        });

        await createNotification(tx, {
          user_id: offer.sender_id,
          type: "booking_offer_accepted",
          title: "가격 제안 수락",
          message: `${offer.amount.toLocaleString("ko-KR")}원 가격 제안이 수락되었습니다.`,
          link_url:
            offer.sender_id === booking.customer_id
              ? customerChatLink(chatRoomId)
              : freelancerChatLink(chatRoomId),
        });

        return { booking: changedBooking, offer: acceptedOffer, contract };
      });

      return successResponse(res, updated, "가격 제안을 수락했습니다.");
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/bookings/:id/offers/:offerId/reject
router.patch(
  "/:id/offers/:offerId/reject",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const booking = await getBookingForUser(req.params.id, req.user!);

      if (!booking || !booking.chat_room) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "예약 또는 상담방을 찾을 수 없습니다.",
          [],
          404,
        );
      }

      if (isContractLocked(booking.contract)) {
        return errorResponse(
          res,
          "CONFLICT",
          "양측 서명이 완료된 계약서는 수정할 수 없습니다. 변경이나 취소가 필요하면 환불/계약 무효화 절차를 진행해 주세요.",
          [],
          409,
        );
      }

      const chatRoomId = booking.chat_room.id;

      const offer = await prisma.bookingOffer.findFirst({
        where: {
          id: req.params.offerId,
          booking_id: booking.id,
          status: "pending",
        },
      });

      if (!offer) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "거절할 수 있는 가격 제안을 찾을 수 없습니다.",
          [],
          404,
        );
      }

      if (offer.receiver_id !== req.user!.userId) {
        return errorResponse(
          res,
          "FORBIDDEN",
          "가격 제안을 받은 사용자만 거절할 수 있습니다.",
          [],
          403,
        );
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

        await tx.chatRoom.update({
          where: { id: chatRoomId },
          data: { last_message_at: new Date() },
        });

        await createNotification(tx, {
          user_id: offer.sender_id,
          type: "booking_offer_rejected",
          title: "가격 제안 거절",
          message: `${offer.amount.toLocaleString("ko-KR")}원 가격 제안이 거절되었습니다.`,
          link_url:
            offer.sender_id === booking.customer_id
              ? customerChatLink(chatRoomId)
              : freelancerChatLink(chatRoomId),
        });

        return rejectedOffer;
      });

      return successResponse(res, rejected, "가격 제안을 거절했습니다.");
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/bookings/:id/cancel
router.patch(
  "/:id/cancel",
  authenticate,
  requireCustomerOrAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userType, userId } = req.user!;
      const { cancel_reason } = req.body;

      const booking = await prisma.booking.findUnique({
        where: { id: req.params.id },
        include: {
          chat_room: true,
          contract: { select: { id: true, status: true } },
        },
      });

      if (!booking) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "예약을 찾을 수 없습니다.",
          [],
          404,
        );
      }

      if (userType === "customer" && booking.customer_id !== userId) {
        return errorResponse(
          res,
          "FORBIDDEN",
          "접근 권한이 없습니다.",
          [],
          403,
        );
      }

      if (!canTransitionBooking(booking.booking_status, "canceled")) {
        return errorResponse(
          res,
          "VALIDATION_ERROR",
          "현재 상태에서는 예약을 취소할 수 없습니다.",
          [],
          400,
        );
      }

      if (!canDirectCancelBooking(booking)) {
        return errorResponse(
          res,
          "CONFLICT",
          "계약 체결 또는 결제 이후에는 일반 취소가 불가합니다. 결제가 완료된 건은 환불 절차를 이용해 주세요.",
          [],
          409,
        );
      }

      const updated = await prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const canceled = await tx.booking.update({
            where: { id: req.params.id },
            data: {
              booking_status: "canceled",
              cancel_reason: cancel_reason || null,
            },
            include: {
              customer: { select: { id: true, name: true } },
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
              offers: { orderBy: { created_at: "desc" }, take: 3 },
              contract: {
                select: {
                  id: true,
                  status: true,
                  customer_signed_at: true,
                  freelancer_signed_at: true,
                  fully_signed_at: true,
                },
              },
            },
          });

          await tx.bookingOffer.updateMany({
            where: { booking_id: booking.id, status: "pending" },
            data: { status: "cancelled" },
          });

          if (booking.contract) {
            await tx.contract.update({
              where: { id: booking.contract.id },
              data: { status: "voided" },
            });
          }

          if (booking.chat_room?.id) {
            await tx.chatMessage.create({
              data: {
                room_id: booking.chat_room.id,
                sender_id: null,
                message: "계약 체결 전 단계에서 예약이 취소되었습니다.",
                message_type: "system",
              },
            });

            await tx.chatRoom.update({
              where: { id: booking.chat_room.id },
              data: { last_message_at: new Date() },
            });
          }

          return canceled;
        },
      );

      return successResponse(
        res,
        await serializeBooking(updated),
        "예약이 취소되었습니다.",
      );
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/bookings/:id/request-completion — 프리랜서 행사 완료 요청
router.patch(
  "/:id/request-completion",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (req.user!.userType !== "freelancer") {
        return errorResponse(
          res,
          "FORBIDDEN",
          "프리랜서만 완료 요청할 수 있습니다.",
          [],
          403,
        );
      }

      const booking = await getBookingForUser(req.params.id, req.user!);
      if (!booking) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "예약을 찾을 수 없습니다.",
          [],
          404,
        );
      }

      if (booking.freelancer.user_id !== req.user!.userId) {
        return errorResponse(
          res,
          "FORBIDDEN",
          "접근 권한이 없습니다.",
          [],
          403,
        );
      }

      if (
        booking.booking_status !== BookingStatus.confirmed ||
        !canRequestOrApproveCompletion(booking)
      ) {
        return errorResponse(
          res,
          "CONFLICT",
          "양측 전자서명과 결제 완료 후 에스크로 보관 중인 예약만 완료 요청할 수 있습니다.",
          [],
          409,
        );
      }

      const updated = await prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const result = await tx.booking.update({
            where: { id: req.params.id },
            data: {
              booking_status: BOOKING_STATUS_COMPLETION_REQUESTED,
              completion_requested_at: new Date(),
            },
          });

          await createNotification(tx, {
            user_id: booking.customer_id,
            type: "completion_requested",
            title: "행사 완료 확인 요청",
            message: `"${booking.event_title}" 행사가 완료되었습니다. 완료를 확인해 주세요.`,
            link_url: `/customer/bookings`,
          });

          return result;
        },
      );

      return successResponse(
        res,
        withTransactionDisplayStatus({ ...updated, contract: booking.contract }),
        "행사 완료 요청이 전달되었습니다. 고객이 확인하면 정산이 진행됩니다.",
      );
    } catch (err) {
      next(err);
    }
  },
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
        include: {
          freelancer: { select: { user_id: true } },
          contract: { select: { status: true } },
        },
      });

      if (!booking) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "예약을 찾을 수 없습니다.",
          [],
          404,
        );
      }

      if (!canRequestOrApproveCompletion(booking)) {
        return errorResponse(
          res,
          "CONFLICT",
          "양측 전자서명과 결제 완료 후 에스크로 보관 중인 예약만 행사 완료를 확인할 수 있습니다.",
          [],
          409,
        );
      }

      const updated = await prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const completed = await tx.booking.update({
            where: { id: req.params.id },
            data: {
              booking_status: BookingStatus.completed,
              settlement_status: "scheduled",
            },
          });

          await notifyReviewRequested(tx, {
            customerUserId: completed.customer_id,
            freelancerUserId: booking.freelancer.user_id,
            eventTitle: completed.event_title,
            bookingId: completed.id,
          });

          return completed;
        },
      );

      return successResponse(
        res,
        withTransactionDisplayStatus({ ...updated, contract: booking.contract }),
        "행사 완료가 확인되었습니다. 후기를 작성해 주세요.",
      );
    } catch (err) {
      next(err);
    }
  },
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
          contract: { select: { status: true } },
        },
      });

      if (!booking) {
        return errorResponse(
          res,
          "NOT_FOUND",
          "예약을 찾을 수 없습니다.",
          [],
          404,
        );
      }

      if (
        !canTransitionBooking(booking.booking_status, "completed") ||
        !canRequestOrApproveCompletion(booking)
      ) {
        return errorResponse(
          res,
          "VALIDATION_ERROR",
          "양측 전자서명과 결제 완료 후 에스크로 보관 중인 예약만 행사 완료 처리할 수 있습니다.",
          [],
          400,
        );
      }

      const updated = await prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const completed = await tx.booking.update({
            where: { id: req.params.id },
            data: {
              booking_status: BookingStatus.completed,
              settlement_status: "scheduled",
            },
          });

          if (
            booking.request &&
            canTransitionRequest(booking.request.status, "completed")
          ) {
            await tx.eventRequest.update({
              where: { id: booking.request.id },
              data: { status: "completed" },
            });
          }

          await notifyReviewRequested(tx, {
            customerUserId: completed.customer_id,
            freelancerUserId: booking.freelancer.user_id,
            eventTitle: completed.event_title,
            bookingId: completed.id,
          });

          return completed;
        },
      );

      return successResponse(
        res,
        withTransactionDisplayStatus({ ...updated, contract: booking.contract }),
        "행사 완료 처리되었습니다.",
      );
    } catch (err) {
      next(err);
    }
  },
);

export default router;
