/**
 * 만료·폐기된 refresh token 정리 유틸리티
 *
 * - 서버 시작 시 1회 실행
 * - 이후 매 24시간마다 반복
 * - 폐기(revoked_at IS NOT NULL) 또는 만료(expires_at < now) 토큰 삭제
 */

import prisma from "../config/database";

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24시간

export async function cleanupExpiredTokens(): Promise<void> {
  try {
    const result = await prisma.refreshToken.deleteMany({
      where: {
        OR: [
          { revoked_at: { not: null } },
          { expires_at: { lt: new Date() } },
        ],
      },
    });

    if (result.count > 0) {
      console.log(`[token-cleanup] 만료/폐기 refresh token ${result.count}건 삭제`);
    }
  } catch (err) {
    // 정리 실패는 서비스에 영향 없음 — 로그만 기록
    console.error("[token-cleanup] 오류:", err);
  }
}

export function scheduleTokenCleanup(): void {
  // 즉시 1회 실행
  void cleanupExpiredTokens();

  // 이후 주기적 실행
  setInterval(() => {
    void cleanupExpiredTokens();
  }, CLEANUP_INTERVAL_MS);
}
