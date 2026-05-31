import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import authRoutes from "./routes/auth";
import usersRoutes from "./routes/users";
import customerRoutes from "./routes/customer";
import freelancerRoutes from "./routes/freelancer";
import publicRoutes from "./routes/public";
import bookingRoutes from "./routes/bookings";
import reviewRoutes from "./routes/reviews";
import adminRoutes from "./routes/admin";
import paymentRoutes from "./routes/payments";

import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { env, isProduction } from "./config/env";
import { noStoreForPrivateApi } from "./utils/cache";
import { verifyTrustedOrigin } from "./middleware/security";
import { scheduleTokenCleanup } from "./utils/cleanupTokens";

const app = express();
const PORT = env.PORT;

// ─── 보안 미들웨어 ───────────────────────────────────────────

app.use(helmet());

const allowedOrigins = [env.CLIENT_URL, env.CLIENT_URL_PROD].filter(Boolean) as string[];

app.use(
  cors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("CORS 정책에 의해 차단되었습니다."));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  })
);

// Cookie 기반 unsafe 메서드 Origin 검증
app.use(verifyTrustedOrigin(allowedOrigins));

// ─── Rate Limiting ───────────────────────────────────────────

// 전역 (IP당 15분/200회)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: "SERVER_ERROR", message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", details: [] },
  },
});

// 인증 엔드포인트 강화 (IP당 15분/20회 — brute-force 방어)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: "SERVER_ERROR", message: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.", details: [] },
  },
});

app.use(globalLimiter);

// ─── 기본 미들웨어 ──────────────────────────────────────────

app.use(express.json({ limit: "1mb" }));
app.use(noStoreForPrivateApi);

if (!isProduction) {
  app.use(morgan("dev"));
} else {
  // 운영 환경: IP/메서드/상태코드/응답시간만 기록 (바디·쿠키 제외)
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

// 인증 (login/signup/refresh는 authLimiter 적용)
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/signup", authLimiter);
app.use("/api/auth/refresh", authLimiter);
app.use("/api/auth", authRoutes);

// 사용자 정보 수정 — 전용 라우터 (기존 authRoutes 재마운트 버그 수정)
app.use("/api/users", usersRoutes);

app.use("/api/customer/requests", customerRoutes);
app.use("/api/freelancer", freelancerRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/admin", adminRoutes);

// ─── 에러 핸들러 ────────────────────────────────────────────

app.use(notFoundHandler);
app.use(errorHandler);

// ─── 서버 시작 ──────────────────────────────────────────────

app.listen(PORT, () => {
  if (!isProduction) {
    console.log(`\n🚀 프리마이크 API 서버`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`   허용 Origin: ${allowedOrigins.join(", ")}\n`);
  } else {
    console.log(`[server] listening on port ${PORT}`);
  }
});

// 만료/폐기 refresh token 주기적 정리 (24시간마다)
scheduleTokenCleanup();

export default app;
