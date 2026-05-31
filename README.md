# FreeMic Server

FreeMic 행사 진행자 매칭 플랫폼의 백엔드 API 서버입니다.

Express, TypeScript, Prisma, Supabase PostgreSQL을 기반으로 하며 JWT 기반 인증과 역할 기반 접근 제어를 제공합니다.

## Tech Stack

* Node.js
* Express
* TypeScript
* Prisma
* Supabase PostgreSQL
* JWT Authentication
* pnpm
* Render

## Getting Started

### Install

```bash
pnpm install
```

### Environment Variables

```bash
cp .env.example .env
```

필수 환경변수는 `.env.example`을 참고합니다.

주요 환경변수:

```env
DATABASE_URL=
DIRECT_URL=
JWT_SECRET=
JWT_EXPIRES_IN=
JWT_REFRESH_EXPIRES_IN=
CLIENT_URL=
CLIENT_URL_PROD=
TOSS_SECRET_KEY=
TOSS_CLIENT_KEY=
```

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

프로덕션 실행:

```bash
pnpm start
```

## Scripts

| Command                | Description        |
| ---------------------- | ------------------ |
| `pnpm dev`             | 개발 서버 실행           |
| `pnpm build`           | TypeScript 빌드      |
| `pnpm start`           | 프로덕션 서버 실행         |
| `pnpm typecheck`       | TypeScript 타입 검사   |
| `pnpm lint`            | ESLint 검사          |
| `pnpm db:generate`     | Prisma Client 생성   |
| `pnpm db:migrate`      | 개발 DB migration 실행 |
| `pnpm db:migrate:prod` | 운영 DB migration 실행 |
| `pnpm db:seed`         | Seed 데이터 생성        |
| `pnpm db:studio`       | Prisma Studio 실행   |

## Health Check

```http
GET /health
```

## Project Structure

```txt
src/
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

## Deployment

Render 배포를 기준으로 구성되어 있습니다.

배포 전 확인 사항:

1. Render 환경변수를 설정합니다.
2. Supabase PostgreSQL 연결 정보를 등록합니다.
3. Prisma migration이 배포 과정에서 실행되도록 설정합니다.
4. 프론트엔드 origin을 CORS 허용 목록에 등록합니다.
5. `/health` 엔드포인트가 정상 응답하는지 확인합니다.

## Render Environment Variables

Render 서비스에 아래 환경변수를 설정합니다.

```env
NODE_ENV=production
DATABASE_URL=
DIRECT_URL=
JWT_SECRET=
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=30d
CLIENT_URL=http://localhost:3000
CLIENT_URL_PROD=
TOSS_SECRET_KEY=
TOSS_CLIENT_KEY=
```

`CLIENT_URL_PROD`에는 프론트엔드 배포 후 실제 프론트엔드 origin을 입력합니다.

예시:

```env
CLIENT_URL_PROD=https://your-client-domain.com
```

## Notes

* `.env`는 커밋하지 않습니다.
* `.env.example`만 repository에 포함합니다.
* 운영 환경에서는 충분히 긴 JWT secret을 사용합니다.
* Supabase 사용 시 runtime DB URL과 migration용 DB URL을 구분합니다.
* Seed 데이터는 배포 과정에서 자동 실행하지 않고, 필요할 때 수동으로 한 번만 실행합니다.
