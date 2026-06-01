import { Prisma, PrismaClient } from "@prisma/client";

type PrismaWriter = PrismaClient | Prisma.TransactionClient;

export type NotificationInput = {
  user_id: string;
  type: string;
  title: string;
  message: string;
  link_url?: string | null;
};

export async function createNotification(
  prismaClient: PrismaWriter,
  input: NotificationInput
) {
  return prismaClient.notification.create({
    data: {
      user_id: input.user_id,
      type: input.type,
      title: input.title,
      message: input.message,
      link_url: input.link_url ?? null,
    },
  });
}
