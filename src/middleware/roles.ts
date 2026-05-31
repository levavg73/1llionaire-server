import { Response, NextFunction } from "express";
import { AuthRequest } from "../types";
import { errorResponse } from "../utils/response";

type UserRole = "customer" | "freelancer" | "admin";

export const requireRole = (...roles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      errorResponse(res, "UNAUTHORIZED", "로그인이 필요합니다.", [], 401);
      return;
    }

    if (!roles.includes(req.user.userType as UserRole)) {
      errorResponse(res, "FORBIDDEN", "접근 권한이 없습니다.", [], 403);
      return;
    }

    next();
  };
};

export const requireAdmin = requireRole("admin");
export const requireCustomer = requireRole("customer");
export const requireFreelancer = requireRole("freelancer");
export const requireCustomerOrAdmin = requireRole("customer", "admin");
export const requireAny = requireRole("customer", "freelancer", "admin");
