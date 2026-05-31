import { Response } from "express";
import { paginationQuerySchema } from "./validation";

// 성공 응답
export const successResponse = (
  res: Response,
  data: unknown,
  message = "요청이 성공적으로 처리되었습니다.",
  statusCode = 200
) => {
  return res.status(statusCode).json({
    success: true,
    data,
    message,
  });
};

// 목록 응답 (pagination)
export const listResponse = (
  res: Response,
  items: unknown[],
  total: number,
  page: number,
  limit: number,
  message = "요청이 성공적으로 처리되었습니다."
) => {
  return res.status(200).json({
    success: true,
    data: {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    },
    message,
  });
};

// 에러 응답
export const errorResponse = (
  res: Response,
  code: string,
  message: string,
  details: unknown[] = [],
  statusCode = 400
) => {
  return res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      details,
    },
  });
};

// pagination 파라미터 파싱
export const parsePagination = (
  query: Record<string, unknown>
): { page: number; limit: number; skip: number } => {
  const parsed = paginationQuerySchema.parse(query);
  const skip = (parsed.page - 1) * parsed.limit;
  return { page: parsed.page, limit: parsed.limit, skip };
};
