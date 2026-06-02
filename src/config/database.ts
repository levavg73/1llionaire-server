import { PrismaClient } from "@prisma/client";
import { env } from "./env";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

// Vercel warm invocation과 로컬 hot reload에서 PrismaClient 중복 생성을 줄입니다.
globalForPrisma.prisma = prisma;

export default prisma;
