import { Request } from "express";

export interface AuthPayload {
  userId: string;
  userType: "customer" | "freelancer" | "admin";
  email: string;
}

export interface AuthRequest extends Request {
  user?: AuthPayload;
}
