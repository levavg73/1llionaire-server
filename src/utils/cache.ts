import { Request, Response, NextFunction } from "express";

export const noStoreForPrivateApi = (req: Request, res: Response, next: NextFunction): void => {
  if (req.path.startsWith("/api") && !req.path.startsWith("/api/public")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
};

export const setPublicCache = (_req: Request, res: Response, next: NextFunction): void => {
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
  next();
};
