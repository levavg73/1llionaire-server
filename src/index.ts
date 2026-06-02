import app from "./app";
import { env, isProduction } from "./config/env";
import { scheduleTokenCleanup } from "./utils/cleanupTokens";

const PORT = env.PORT;

// Vercel에서는 Express app을 default export로 사용합니다.
// 로컬 개발/Render 같은 장기 실행 서버에서만 listen과 interval 작업을 시작합니다.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    if (!isProduction) {
      console.log(`\n🚀 프리마이크 API 서버`);
      console.log(`   http://localhost:${PORT}\n`);
    } else {
      console.log(`[server] listening on port ${PORT}`);
    }
  });

  scheduleTokenCleanup();
}

export default app;
