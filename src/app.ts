import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import authRoutes from "./routes/auth";
import oauthRoutes from "./routes/oauth";
import usersRoutes from "./routes/users";
import customerRoutes from "./routes/customer";
import freelancerRoutes from "./routes/freelancer";
import publicRoutes from "./routes/public";
import bookingRoutes from "./routes/bookings";
import reviewRoutes from "./routes/reviews";
import freelancerReviewRoutes from "./routes/freelancer-reviews";
import adminRoutes from "./routes/admin";
import paymentRoutes from "./routes/payments";
import notificationRoutes from "./routes/notifications";
import chatRoutes from "./routes/chat";
import contractRoutes from "./routes/contracts";
import aiRoutes from "./routes/ai";

import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { env, isProduction } from "./config/env";
import { noStoreForPrivateApi } from "./utils/cache";
import { verifyTrustedOrigin } from "./middleware/security";

const app = express();

// ─── 보안 미들웨어 ───────────────────────────────────────────

app.set("trust proxy", 1);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

const allowedOrigins = [env.CLIENT_URL, env.CLIENT_URL_PROD].filter(
  Boolean
) as string[];

app.use(
  cors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void
    ) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("CORS 정책에 의해 차단되었습니다."));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  })
);

app.use(verifyTrustedOrigin(allowedOrigins));

// ─── Rate Limiting ───────────────────────────────────────────

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: "SERVER_ERROR",
      message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      details: [],
    },
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: "SERVER_ERROR",
      message: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      details: [],
    },
  },
});

// AI 분석은 별도 rate limit (모델 비용 보호)
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1시간
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: "SERVER_ERROR",
      message: "AI 분석 요청 횟수를 초과했습니다. 1시간 후 다시 시도해 주세요.",
      details: [],
    },
  },
});

app.use(globalLimiter);

// ─── 기본 미들웨어 ──────────────────────────────────────────

app.use(express.json({ limit: "1mb" }));
app.use(noStoreForPrivateApi);

if (!isProduction) {
  app.use(morgan("dev"));
} else {
  app.use(morgan(":remote-addr :method :url :status - :response-time ms"));
}

// ─── 헬스체크 ───────────────────────────────────────────────

app.get("/health", (_req: express.Request, res: express.Response) => {
  res.json({
    success: true,
    data: { status: "ok", env: env.NODE_ENV, timestamp: new Date().toISOString() },
    message: "서버가 정상 동작 중입니다.",
  });
});

// ─── 라우트 ────────────────────────────────────────────────

// 인증
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/signup", authLimiter);
app.use("/api/auth/refresh", authLimiter);
app.use("/api/auth", authRoutes);

// 소셜 로그인 (rate limit 동일 적용)
app.use("/api/auth/oauth", authLimiter, oauthRoutes);

// 사용자
app.use("/api/users", usersRoutes);

// 서비스 라우트
app.use("/api/customer/requests", customerRoutes);
app.use("/api/freelancer", freelancerRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/freelancer-reviews", freelancerReviewRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/contracts", contractRoutes);

// AI 분석 (전용 rate limit)
app.use("/api/ai", aiLimiter, aiRoutes);

// 공개 & 관리자
app.use("/api/public", publicRoutes);
app.use("/api/admin", adminRoutes);

// ─── 에러 핸들러 ────────────────────────────────────────────

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
