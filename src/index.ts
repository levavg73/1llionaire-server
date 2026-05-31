import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import authRoutes from "./routes/auth";
import customerRoutes from "./routes/customer";
import freelancerRoutes from "./routes/freelancer";
import publicRoutes from "./routes/public";
import bookingRoutes from "./routes/bookings";
import reviewRoutes from "./routes/reviews";
import adminRoutes from "./routes/admin";
import paymentRoutes from "./routes/payments";

import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { authenticate } from "./middleware/auth";
import { env, isVercel } from "./config/env";
import { noStoreForPrivateApi } from "./utils/cache";
import { verifyTrustedOrigin } from "./middleware/security";

const app = express();
const PORT = env.PORT;

// ─── 보안 미들웨어 ───────────────────────────────────────────

app.use(helmet());

// CORS - 허용된 프론트엔드 주소만 접근 허용
const allowedOrigins = [env.CLIENT_URL, env.CLIENT_URL_PROD].filter(Boolean) as string[];

app.use(
  cors({
    origin: (origin, callback) => {
      // Postman 또는 서버간 요청 허용 (origin이 없는 경우)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("CORS 정책에 의해 차단되었습니다."));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token", "X-Requested-With"],
  })
);

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15분
  max: 200,
  message: {
    success: false,
    error: {
      code: "SERVER_ERROR",
      message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      details: [],
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(verifyTrustedOrigin(allowedOrigins));
app.use(limiter);

// ─── 기본 미들웨어 ──────────────────────────────────────────

app.use(express.json({ limit: "1mb" }));
app.use(noStoreForPrivateApi);

// 로깅 (배포 환경에서는 민감 정보 제외)
if (env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
} else {
  app.use(morgan("combined"));
}

// ─── 헬스체크 ───────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    data: {
      status: "ok",
      env: env.NODE_ENV,
      timestamp: new Date().toISOString(),
    },
    message: "서버가 정상 동작 중입니다.",
  });
});

// ─── 라우트 ────────────────────────────────────────────────

// 인증
app.use("/api/auth", authRoutes);
app.use("/api/users", authenticate, authRoutes); // PATCH /api/users/me 재사용

// 고객 요청서
app.use("/api/customer/requests", customerRoutes);

// 프리랜서
app.use("/api/freelancer", freelancerRoutes);

// 예약
app.use("/api/bookings", bookingRoutes);

// 후기
app.use("/api/reviews", reviewRoutes);

// 공개 API
app.use("/api/public", publicRoutes);

// 관리자
app.use("/api/payments", paymentRoutes);
app.use("/api/admin", adminRoutes);

// ─── 에러 핸들러 ────────────────────────────────────────────

app.use(notFoundHandler);
app.use(errorHandler);

// ─── 서버 시작 ──────────────────────────────────────────────

if (!isVercel) {
  app.listen(PORT, () => {
    const isDev = env.NODE_ENV !== "production";
    if (isDev) {
      console.log(`\n🚀 프리마이크 API 서버 시작`);
      console.log(`   URL: http://localhost:${PORT}`);
      console.log(`   ENV: ${env.NODE_ENV}`);
      console.log(`   허용 Origin: ${allowedOrigins.join(", ")}\n`);
    }
  });
}

export default app;
