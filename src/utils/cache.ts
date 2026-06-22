import { Request, Response, NextFunction } from "express";

export const noStoreForPrivateApi = (req: Request, res: Response, next: NextFunction): void => {
  if (req.path.startsWith("/api") && !req.path.startsWith("/api/public")) {
    res.setHeader("Cache-Control", "private, no-store, no-cache, max-age=0, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
};

export const setPublicCache = (_req: Request, res: Response, next: NextFunction): void => {
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
  next();
};
