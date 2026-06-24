import { Request, Response, NextFunction } from "express";

const NO_STORE_VALUE = "private, no-store, no-cache, max-age=0, must-revalidate";

export const noStoreForPrivateApi = (req: Request, res: Response, next: NextFunction): void => {
  if (req.path.startsWith("/api") && !req.path.startsWith("/api/public")) {
    res.setHeader("Cache-Control", NO_STORE_VALUE);
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
};

export const setPublicCache = (_req: Request, res: Response, next: NextFunction): void => {
  // Public profile pages and review counts are edited/imported directly during
  // migrations and admin operations. Serving them through an edge cache can
  // leave old freelancer IDs, stale review_count values, or deleted profile
  // details visible in the client, which leads to intermittent 404 pages and
  // review/count mismatches after a DB handoff. Keep these responses fresh.
  res.setHeader("Cache-Control", NO_STORE_VALUE);
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
};
