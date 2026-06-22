# Voit Server

Voit(보잇)은 기업·기관·개인 고객이 행사 목적과 조건에 맞는 전문 진행자를 비교하고 섭외할 수 있도록 돕는 프리랜서 진행자 매칭 플랫폼입니다.

이 서버는 고객 요청서, 진행자 프로필, 영상·음성 포트폴리오 URL, 조건 기반 후보 추천 초안, 관리자 검수, 상담·예약, 결제·정산, 구조화 후기 API를 제공합니다.

Express, TypeScript, Prisma, Supabase PostgreSQL을 기반으로 하며 JWT 기반 인증과 역할 기반 접근 제어를 사용합니다.

## Tech Stack

- Node.js
- Express
- TypeScript
- Prisma
- Supabase PostgreSQL
- Supabase Storage
- JWT Authentication
- pnpm
- Vercel Functions

## Matching Flow

1. 고객이 행사 종류, 일정, 지역, 예산, 희망 진행자 유형, 원하는 진행 분위기, 필요 언어, 대본/리허설/출장 조건을 포함한 요청서를 작성합니다.
2. 서버가 승인된 진행자 프로필의 가능 분야, 진행 스타일, 가능 지역, 단가, 언어, 후기 데이터를 기준으로 후보 초안을 생성합니다.
3. 관리자가 후보 초안을 검수하거나 직접 후보를 추가한 뒤 요청서 상태를 `recommended`로 변경하면 고객에게 추천 후보가 공개됩니다.
4. 고객은 후보의 프로필, 영상·음성 포트폴리오 URL, 경력, 가격대, 후기 정보를 비교하고 상담·예약을 진행합니다.
5. 행사 완료 후 고객이 구조화 후기를 작성하면 진행자의 신뢰 자산으로 축적됩니다.

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
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_PROFILE_IMAGE_BUCKET=profile-images
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

타입 검사:

```bash
pnpm typecheck
```

빌드:

```bash
pnpm build
```

프로덕션 실행, Vercel 외 장기 실행 서버용:

```bash
pnpm start
```

## Health Check

```http
GET /health
```

## Project Structure

```txt
src/
├── app.ts
├── index.ts
├── config/
├── middleware/
├── routes/
├── services/
├── types/
└── utils/

prisma/
├── migrations/
├── schema.prisma
└── seed.ts
```

## Notes

- `.env`는 커밋하지 않습니다.
- `.env.example`만 repository에 포함합니다.
- 운영 환경에서는 충분히 긴 JWT secret을 사용합니다.
- 포트폴리오는 실제 미디어 파일 업로드가 아니라 영상·음성 URL 등록 방식입니다.
- 추천 후보 초안은 관리자 검수 후 고객에게 공개됩니다.
