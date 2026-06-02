# FreeMic Server

행사 진행자 매칭 플랫폼의 백엔드 API 서버입니다.

Express, TypeScript, Prisma, Supabase PostgreSQL을 기반으로 하며 JWT 기반 인증과 역할 기반 접근 제어를 제공합니다.

## Tech Stack

- Node.js
- Express
- TypeScript
- Prisma
- Supabase PostgreSQL
- JWT Authentication
- pnpm
- Vercel Functions

## Vercel 변경 사항

- Express 앱 설정을 `src/app.ts`로 분리했습니다.
- `src/index.ts`는 Vercel에서 default export되는 Express app 역할을 합니다.
- 로컬 개발 또는 장기 실행 서버에서만 `app.listen()`과 refresh token cleanup interval을 실행합니다.
- SSE 기반 `/api/notifications/stream`을 제거했습니다.
- 알림은 DB에 저장하고, 프론트엔드가 `GET /api/notifications/unread-count`와 `GET /api/notifications`를 polling하는 **DB 기반 인앱 알림** 방식입니다.
- PrismaClient는 Vercel warm invocation에서 재사용되도록 global singleton으로 구성했습니다.

## Getting Started

### Install

```bash
pnpm install
```

### Environment Variables

```bash
cp .env.example .env
```

주요 환경변수:

```env
DATABASE_URL=
DIRECT_URL=
JWT_SECRET=
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=30d
CLIENT_URL=http://localhost:3000
CLIENT_URL_PROD=https://your-client.vercel.app
TOSS_SECRET_KEY=
TOSS_CLIENT_KEY=
```

`CLIENT_URL_PROD`에는 실제 프론트엔드 Vercel origin을 입력합니다. 예: `https://your-client.vercel.app`

## Database

Prisma Client 생성:

```bash
pnpm db:generate
```

개발 환경 migration 실행:

```bash
pnpm db:migrate
```

운영 환경 migration 실행:

```bash
pnpm db:migrate:prod
```

Seed 실행:

```bash
pnpm db:seed
```

Prisma Studio 실행:

```bash
pnpm db:studio
```

## Run

개발 서버 실행:

```bash
pnpm dev
```

빌드:

```bash
pnpm build
```

Vercel build/typecheck:

```bash
pnpm vercel-build
```

프로덕션 실행, Vercel 외 장기 실행 서버용:

```bash
pnpm start
```

## Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | 개발 서버 실행 |
| `pnpm build` | Prisma Client 생성 + TypeScript 빌드 |
| `pnpm vercel-build` | Prisma Client 생성 + TypeScript 타입 검사 |
| `pnpm start` | 프로덕션 서버 실행, Vercel 외 환경 |
| `pnpm typecheck` | TypeScript 타입 검사 |
| `pnpm lint` | ESLint 검사 |
| `pnpm db:generate` | Prisma Client 생성 |
| `pnpm db:migrate` | 개발 DB migration 실행 |
| `pnpm db:migrate:prod` | 운영 DB migration 실행 |
| `pnpm db:seed` | Seed 데이터 생성 |
| `pnpm db:studio` | Prisma Studio 실행 |

## Health Check

```http
GET /health
```

## Project Structure

```txt
src/
├── app.ts          # Express app 설정, Vercel/로컬 공통
├── index.ts        # Vercel default export + 로컬 listen
├── config/
├── middleware/
├── routes/
├── types/
└── utils/

prisma/
├── migrations/
├── schema.prisma
└── seed.ts
```

## Vercel Deployment

1. Vercel에서 서버 repository를 별도 Project로 import합니다.
2. Root Directory를 서버 프로젝트 루트로 지정합니다.
3. 환경변수를 Vercel Project Settings에 등록합니다.
4. Supabase PostgreSQL의 pooled connection URL을 `DATABASE_URL`에 넣고, migration용 direct URL을 `DIRECT_URL`에 넣습니다.
5. 배포 전 또는 배포 후 1회 `pnpm db:migrate:prod`를 실행합니다.
6. 배포된 서버 URL을 클라이언트의 `NEXT_PUBLIC_API_BASE_URL`에 설정합니다.
7. 배포된 클라이언트 URL을 서버의 `CLIENT_URL_PROD`에 설정합니다.

## Notes

- `.env`는 커밋하지 않습니다.
- `.env.example`만 repository에 포함합니다.
- 운영 환경에서는 충분히 긴 JWT secret을 사용합니다.
- Seed 데이터는 배포 과정에서 자동 실행하지 않고, 필요할 때 수동으로 한 번만 실행합니다.
- `render.legacy.yaml`은 이전 Render 배포 참고용으로만 남겨 두었습니다.
