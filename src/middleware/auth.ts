import { Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { AuthRequest, AuthPayload } from "../types";
import { errorResponse } from "../utils/response";
import { env } from "../config/env";
import { getAccessTokenFromRequest } from "../utils/authTokens";

const getBearerToken = (authorizationHeader: string | undefined): string | undefined => {
  if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) return undefined;
  return authorizationHeader.split(" ")[1];
};

const getToken = (req: AuthRequest): string | undefined => {
  return getBearerToken(req.headers.authorization) ?? getAccessTokenFromRequest(req.headers.cookie);
};

export const authenticate = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  const token = getToken(req);

  if (!token) {
    errorResponse(res, "UNAUTHORIZED", "로그인이 필요합니다.", [], 401);
    return;
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as AuthPayload;
    req.user = payload;
    next();
  } catch {
    errorResponse(res, "UNAUTHORIZED", "인증 토큰이 유효하지 않습니다.", [], 401);
    return;
  }
};

// 선택적 인증 (공개 API에서 로그인 여부만 확인)
export const optionalAuthenticate = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): void => {
  const token = getToken(req);

  if (token) {
    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as AuthPayload;
      req.user = payload;
    } catch {
      // 토큰 오류 무시 (선택적 인증)
    }
  }
  next();
};
