import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import prisma from "../config/database";
import { authenticate } from "../middleware/auth";
import { AuthRequest } from "../types";
import { successResponse, errorResponse, listResponse, parsePagination } from "../utils/response";
import { createNotification } from "../utils/notifications";
import { withTransactionDisplayStatus } from "../utils/bookingLifecycle";

const router = Router();

const sendMessageSchema = z.object({
  message: z.string().trim().min(1, "메시지를 입력해 주세요.").max(2000),
});

router.use(authenticate);

async function getParticipantRoom(roomId: string, userId: string, userType: string) {
  const room = await prisma.chatRoom.findUnique({
    where: { id: roomId },
    include: {
      customer: { select: { id: true, name: true } },
      freelancer: { select: { id: true, user_id: true, display_name: true } },
      booking: {
        select: {
          id: true,
          customer_id: true,
          freelancer_id: true,
          event_title: true,
          event_date: true,
          booking_status: true,
          payment_status: true,
          settlement_status: true,
          escrow_status: true,
          contract: { select: { status: true } },
          final_price: true,
        },
      },
    },
  });

  if (!room) return null;

  const isCustomer = room.customer_id === userId;
  const isFreelancer = room.freelancer.user_id === userId;
  const isAdmin = userType === "admin";

  if (!isCustomer && !isFreelancer && !isAdmin) return null;

  return room.booking
    ? {
        ...room,
        booking: withTransactionDisplayStatus(room.booking),
      }
    : room;
}

function getOtherParticipantUserId(room: { customer_id: string; freelancer: { user_id: string } }, userId: string) {
  return room.customer_id === userId ? room.freelancer.user_id : room.customer_id;
}

function getOtherParticipantChatLink(room: { id: string; customer_id: string }, userId: string) {
  return room.customer_id === userId ? `/freelancer/chats/${room.id}` : `/customer/chats/${room.id}`;
}

// GET /api/chat/rooms - 내 상담방 목록
router.get("/rooms", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
    const { userId, userType } = req.user!;

    let where = {};

    if (userType === "customer") {
      where = { customer_id: userId };
    } else if (userType === "freelancer") {
      const profile = await prisma.freelancerProfile.findUnique({ where: { user_id: userId } });
      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프리랜서 프로필을 찾을 수 없습니다.", [], 404);
      }
      where = { freelancer_id: profile.id };
    }

    const [items, total] = await Promise.all([
      prisma.chatRoom.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ last_message_at: "desc" }, { created_at: "desc" }],
        include: {
          booking: {
            select: {
              id: true,
              event_title: true,
              event_date: true,
              booking_status: true,
              payment_status: true,
              settlement_status: true,
              escrow_status: true,
              contract: { select: { status: true } },
              final_price: true,
            },
          },
          customer: { select: { id: true, name: true } },
          freelancer: { select: { id: true, display_name: true } },
          messages: {
            orderBy: { created_at: "desc" },
            take: 1,
          },
        },
      }),
      prisma.chatRoom.count({ where }),
    ]);

    const responseItems = items.map((room) =>
      room.booking
        ? {
            ...room,
            booking: withTransactionDisplayStatus(room.booking),
          }
        : room,
    );

    return listResponse(res, responseItems, total, page, limit);
  } catch (err) {
    next(err);
  }
});

// GET /api/chat/rooms/:roomId/messages - 상담 메시지 목록
router.get("/rooms/:roomId/messages", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const room = await getParticipantRoom(req.params.roomId, req.user!.userId, req.user!.userType);

    if (!room) {
      return errorResponse(res, "NOT_FOUND", "상담방을 찾을 수 없습니다.", [], 404);
    }

    const messages = await prisma.chatMessage.findMany({
      where: { room_id: room.id },
      orderBy: { created_at: "asc" },
      include: {
        sender: { select: { id: true, name: true, user_type: true } },
        offer: true,
      },
    });

    return successResponse(res, { room, messages });
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/rooms/:roomId/messages - 상담 메시지 전송
router.post("/rooms/:roomId/messages", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = sendMessageSchema.parse(req.body);
    const room = await getParticipantRoom(req.params.roomId, req.user!.userId, req.user!.userType);

    if (!room) {
      return errorResponse(res, "NOT_FOUND", "상담방을 찾을 수 없습니다.", [], 404);
    }

    const otherUserId = getOtherParticipantUserId(room, req.user!.userId);

    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.chatMessage.create({
        data: {
          room_id: room.id,
          sender_id: req.user!.userId,
          message: body.message,
          message_type: "text",
        },
        include: {
          sender: { select: { id: true, name: true, user_type: true } },
          offer: true,
        },
      });

      await tx.chatRoom.update({
        where: { id: room.id },
        data: { last_message_at: new Date() },
      });

      await createNotification(tx, {
        user_id: otherUserId,
        type: "chat_message",
        title: "새 상담 메시지",
        message: `${req.user!.email} 님이 메시지를 보냈습니다.`,
        link_url: getOtherParticipantChatLink(room, req.user!.userId),
      });

      return created;
    });

    return successResponse(res, message, "메시지가 전송되었습니다.", 201);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/chat/rooms/:roomId/read - 상대 메시지 읽음 처리
router.patch("/rooms/:roomId/read", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const room = await getParticipantRoom(req.params.roomId, req.user!.userId, req.user!.userType);

    if (!room) {
      return errorResponse(res, "NOT_FOUND", "상담방을 찾을 수 없습니다.", [], 404);
    }

    await prisma.chatMessage.updateMany({
      where: {
        room_id: room.id,
        sender_id: { not: req.user!.userId },
        is_read: false,
      },
      data: { is_read: true },
    });

    return successResponse(res, null, "메시지를 읽음 처리했습니다.");
  } catch (err) {
    next(err);
  }
});

export default router;
