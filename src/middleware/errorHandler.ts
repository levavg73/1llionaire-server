import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

// Minimal Prisma error interface to avoid dependency on ungenerated client
interface PrismaError extends Error {
  code?: string;
}

export const errorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  // Zod 입력값 오류
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "입력값을 확인해 주세요.",
        details: err.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      },
    });
    return;
  }

  // Prisma 고유 제약 오류
  const prismaErr = err as PrismaError;
  if (prismaErr.code === "P2002") {
      res.status(409).json({
        success: false,
        error: {
          code: "CONFLICT",
          message: "이미 존재하는 데이터입니다.",
          details: [],
        },
      });
      return;
    }

  if (prismaErr.code === "P2025") {
    res.status(404).json({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "요청하신 리소스를 찾을 수 없습니다.",
        details: [],
      },
    });
    return;
  }

  // 배포 환경에서 스택 트레이스 제거
  const isDev = process.env.NODE_ENV === "development";
  if (isDev) {
    console.error("[Error]", err);
  }

  res.status(500).json({
    success: false,
    error: {
      code: "SERVER_ERROR",
      message: "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
      details: [],
    },
  });
};

export const notFoundHandler = (_req: Request, res: Response): void => {
  res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: "요청하신 경로를 찾을 수 없습니다.",
      details: [],
    },
  });
};
