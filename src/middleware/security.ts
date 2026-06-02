import { NextFunction, Request, Response } from "express";
import { errorResponse } from "../utils/response";
import { isAllowedClientOrigin } from "../utils/origins";

const AUTH_COOKIE_NAMES = ["access_token", "refresh_token"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const requestHasAuthCookie = (cookieHeader: string | undefined): boolean => {
  if (!cookieHeader) return false;
  return AUTH_COOKIE_NAMES.some((cookieName) => cookieHeader.includes(`${cookieName}=`));
};

export const verifyTrustedOrigin = () => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();

    // Public unauthenticated writes such as signup/login do not have auth cookies yet.
    // Cookie-authenticated state-changing requests must come from the configured frontend origins.
    if (!requestHasAuthCookie(req.headers.cookie)) return next();

    const origin = req.headers.origin;
    if (!origin || !isAllowedClientOrigin(origin)) {
      return errorResponse(
        res,
        "FORBIDDEN",
        "허용되지 않은 요청 출처입니다.",
        [],
        403
      );
    }

    return next();
  };
};
