import { Router, Response, NextFunction } from "express";
import crypto from "node:crypto";
import multer from "multer";
import { z } from "zod";
import prisma from "../config/database";
import { authenticate } from "../middleware/auth";
import { requireFreelancer } from "../middleware/roles";
import { AuthRequest } from "../types";
import {
  successResponse,
  errorResponse,
  listResponse,
  parsePagination,
} from "../utils/response";
import {
  optionalHttpsUrl,
  optionalShortText,
  optionalStringArray,
  requiredHttpsUrl,
  requiredStringArray,
} from "../utils/validation";
import {
  PROFILE_IMAGE_BUCKET,
  PROFILE_IMAGE_MAX_SIZE,
  attachSignedProfileImageUrl,
  createProfileImageSignedUrl,
  getSupabaseAdminClient,
  isOwnProfileImagePath,
} from "../utils/profileImages";
import {
  SIGNATURE_VOICE_BUCKET,
  SIGNATURE_VOICE_MAX_SIZE,
  attachSignedSignatureVoiceUrl,
  createSignatureVoiceSignedUrl,
  getSupabaseSignatureVoiceAdminClient,
  isOwnSignatureVoicePath,
} from "../utils/signatureVoice";

const router = Router();

const allowedProfileImageMimeTypes = new Set(["image/jpeg", "image/png"]);
const allowedSignatureVoiceMimeTypes = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
  "audio/webm",
]);

function getProfileImageExtension(file: Express.Multer.File) {
  if (file.mimetype === "image/png") return ".png";
  return ".jpg";
}

function getSignatureVoiceExtension(file: Express.Multer.File) {
  if (["audio/wav", "audio/wave", "audio/x-wav"].includes(file.mimetype)) return ".wav";
  if (["audio/mp4", "audio/x-m4a"].includes(file.mimetype)) return ".m4a";
  if (file.mimetype === "audio/webm") return ".webm";
  return ".mp3";
}

function hasValidProfileImageSignature(file: Express.Multer.File) {
  const { buffer } = file;

  if (file.mimetype === "image/png") {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return buffer.length >= pngSignature.length && buffer.subarray(0, pngSignature.length).equals(pngSignature);
  }

  if (file.mimetype === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }

  return false;
}

function hasValidSignatureVoiceSignature(file: Express.Multer.File) {
  const { buffer } = file;

  if (["audio/mpeg", "audio/mp3"].includes(file.mimetype)) {
    const hasId3Tag = buffer.length >= 3 && buffer.subarray(0, 3).toString("ascii") === "ID3";
    const hasMp3FrameSync = buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
    return hasId3Tag || hasMp3FrameSync;
  }

  if (["audio/wav", "audio/wave", "audio/x-wav"].includes(file.mimetype)) {
    return (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WAVE"
    );
  }

  if (["audio/mp4", "audio/x-m4a"].includes(file.mimetype)) {
    return buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp";
  }

  if (file.mimetype === "audio/webm") {
    const webmSignature = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
    return buffer.length >= webmSignature.length && buffer.subarray(0, webmSignature.length).equals(webmSignature);
  }

  return false;
}

function buildProfileImageStoragePath(userId: string, file: Express.Multer.File) {
  return `freelancers/${userId}/${Date.now()}-${crypto.randomUUID()}${getProfileImageExtension(file)}`;
}

function buildSignatureVoiceStoragePath(userId: string, file: Express.Multer.File) {
  return `freelancers/${userId}/signature-voice/${Date.now()}-${crypto.randomUUID()}${getSignatureVoiceExtension(file)}`;
}

async function deleteStoredProfileImage(path?: string | null) {
  if (!path) return;

  const { error } = await getSupabaseAdminClient()
    .storage
    .from(PROFILE_IMAGE_BUCKET)
    .remove([path]);

  if (error) {
    throw error;
  }
}

async function deleteStoredSignatureVoice(path?: string | null) {
  if (!path) return;

  const { error } = await getSupabaseSignatureVoiceAdminClient()
    .storage
    .from(SIGNATURE_VOICE_BUCKET)
    .remove([path]);

  if (error) {
    throw error;
  }
}

async function tryDeleteStoredProfileImage(path?: string | null) {
  if (!path) return;

  try {
    await deleteStoredProfileImage(path);
  } catch (err) {
    console.error("[supabase-profile-image-delete-error]", err);
  }
}

async function tryDeleteStoredSignatureVoice(path?: string | null) {
  if (!path) return;

  try {
    await deleteStoredSignatureVoice(path);
  } catch (err) {
    console.error("[supabase-signature-voice-delete-error]", err);
  }
}

const profileImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: PROFILE_IMAGE_MAX_SIZE,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (!allowedProfileImageMimeTypes.has(file.mimetype)) {
      cb(new Error("프로필 이미지는 JPG 또는 PNG 파일만 업로드할 수 있습니다."));
      return;
    }

    cb(null, true);
  },
});

const signatureVoiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: SIGNATURE_VOICE_MAX_SIZE,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (!allowedSignatureVoiceMimeTypes.has(file.mimetype)) {
      cb(new Error("시그니처 보이스는 MP3, WAV, M4A, WEBM 오디오 파일만 업로드할 수 있습니다."));
      return;
    }

    cb(null, true);
  },
});

function handleProfileImageUpload(req: AuthRequest, res: Response, next: NextFunction) {
  profileImageUpload.single("image")(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }

    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return errorResponse(res, "BAD_REQUEST", "프로필 이미지는 5MB 이하만 업로드할 수 있습니다.", [], 400);
    }

    const message = err instanceof Error ? err.message : "프로필 이미지 업로드 요청이 올바르지 않습니다.";
    return errorResponse(res, "BAD_REQUEST", message, [], 400);
  });
}

function handleSignatureVoiceUpload(req: AuthRequest, res: Response, next: NextFunction) {
  signatureVoiceUpload.single("voice")(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }

    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return errorResponse(res, "BAD_REQUEST", "시그니처 보이스는 10MB 이하만 업로드할 수 있습니다.", [], 400);
    }

    const message = err instanceof Error ? err.message : "시그니처 보이스 업로드 요청이 올바르지 않습니다.";
    return errorResponse(res, "BAD_REQUEST", message, [], 400);
  });
}

function assertOwnProfileImagePath(req: AuthRequest, res: Response, path: string) {
  if (isOwnProfileImagePath(req.user!.userId, path)) return true;

  errorResponse(
    res,
    "VALIDATION_ERROR",
    "프로필 이미지는 본인 계정으로 업로드된 이미지 경로만 사용할 수 있습니다.",
    [],
    400
  );
  return false;
}

function assertOwnSignatureVoicePath(req: AuthRequest, res: Response, path: string) {
  if (isOwnSignatureVoicePath(req.user!.userId, path)) return true;

  errorResponse(
    res,
    "VALIDATION_ERROR",
    "시그니처 보이스는 본인 계정으로 업로드된 오디오 경로만 사용할 수 있습니다.",
    [],
    400
  );
  return false;
}

const optionalStoragePath = z.preprocess(
  (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
  z.string().trim().max(2048, "파일 경로는 2048자 이하로 입력해 주세요.").optional()
);

// ── Zod 스키마 ──────────────────────────────────────────────

const profileSchema = z
  .object({
    display_name: z.string().trim().min(1, "활동명을 입력해 주세요.").max(50),
    profile_image_path: z
      .string({ required_error: "프로필 이미지를 업로드해 주세요." })
      .trim()
      .min(1, "프로필 이미지를 업로드해 주세요.")
      .max(2048, "이미지 경로는 2048자 이하로 입력해 주세요."),
    profile_image_url: z.string().url().max(4096).optional(),
    signature_voice_path: optionalStoragePath,
    signature_voice_url: z.string().url().max(4096).optional(),
    headline: z.string().trim().min(1, "한 줄 소개를 입력해 주세요.").max(150),
    bio: z.string().trim().min(1, "자기소개를 입력해 주세요.").max(2000),
    region: z.string().trim().min(1, "활동 지역을 입력해 주세요.").max(100),
    available_regions: requiredStringArray(30, 50),
    categories: requiredStringArray(20, 50),
    styles: requiredStringArray(20, 50),
    career_years: z.number().int().min(0).max(50).optional(),
    base_price_min: z
      .number({ required_error: "최소 가격을 입력해 주세요." })
      .int()
      .min(0, "최소 가격은 0원 이상이어야 합니다."),
    base_price_max: z
      .number({ required_error: "최대 가격을 입력해 주세요." })
      .int()
      .min(0, "최대 가격은 0원 이상이어야 합니다."),
    languages: optionalStringArray(20, 50),
    script_writing_available: z.boolean().optional(),
    rehearsal_available: z.boolean().optional(),
    travel_available: z.boolean().optional(),
  })
  .superRefine((body, ctx) => {
    if (body.base_price_min > body.base_price_max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["base_price_max"],
        message: "최대 기본 금액은 최소 기본 금액보다 크거나 같아야 합니다.",
      });
    }
  });

const portfolioSchema = z.object({
  portfolio_type: z.enum(["intro_video", "event_video", "audio_sample", "other"]),
  title: z.string().trim().min(1, "제목을 입력해 주세요.").max(200),
  description: optionalShortText(1000),
  media_url: requiredHttpsUrl,
  thumbnail_url: optionalHttpsUrl,
  category: optionalShortText(100),
  is_representative: z.boolean().default(false),
  is_public: z.boolean().default(true),
});

const quoteSchema = z.object({
  request_id: z.string().min(1),
  price: z.number().int().positive("금액을 입력해 주세요."),
  included_services: optionalShortText(1000),
  script_included: z.boolean().default(false),
  rehearsal_included: z.boolean().default(false),
  travel_fee_included: z.boolean().default(false),
  message: optionalShortText(2000),
  valid_until: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), "유효한 견적 유효기간을 입력해 주세요.")
    .refine((value) => new Date(value) > new Date(), "견적 유효기간은 현재 이후여야 합니다.")
    .optional(),
});

// ─── 프로필 ─────────────────────────────────────────────────

// POST /api/freelancer/profile-image - Supabase Storage 프로필 이미지 업로드
router.post(
  "/profile-image",
  authenticate,
  requireFreelancer,
  handleProfileImageUpload,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const file = req.file;

      if (!file) {
        return errorResponse(res, "BAD_REQUEST", "업로드할 프로필 이미지를 선택해 주세요.", [], 400);
      }

      if (!hasValidProfileImageSignature(file)) {
        return errorResponse(res, "BAD_REQUEST", "프로필 이미지는 정상적인 JPG 또는 PNG 파일만 업로드할 수 있습니다.", [], 400);
      }

      let supabase;
      try {
        supabase = getSupabaseAdminClient();
      } catch (err) {
        console.error("[supabase-storage-config-error]", err);
        return errorResponse(res, "SERVER_ERROR", "프로필 이미지 저장소 설정이 누락되었습니다.", [], 500);
      }

      const storagePath = buildProfileImageStoragePath(req.user!.userId, file);
      const { data, error } = await supabase.storage
        .from(PROFILE_IMAGE_BUCKET)
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          cacheControl: "31536000",
          upsert: false,
        });

      if (error || !data) {
        console.error("[supabase-profile-image-upload-error]", error);
        return errorResponse(res, "SERVER_ERROR", "프로필 이미지 업로드에 실패했습니다.", [], 500);
      }

      const signedUrl = await createProfileImageSignedUrl(data.path);

      return successResponse(
        res,
        { url: signedUrl, path: data.path },
        "프로필 이미지가 업로드되었습니다.",
        201
      );
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/freelancer/signature-voice - Supabase Storage 시그니처 보이스 업로드
router.post(
  "/signature-voice",
  authenticate,
  requireFreelancer,
  handleSignatureVoiceUpload,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const file = req.file;

      if (!file) {
        return errorResponse(res, "BAD_REQUEST", "업로드할 시그니처 보이스 파일을 선택해 주세요.", [], 400);
      }

      if (!hasValidSignatureVoiceSignature(file)) {
        return errorResponse(
          res,
          "BAD_REQUEST",
          "시그니처 보이스는 정상적인 MP3, WAV, M4A, WEBM 오디오 파일만 업로드할 수 있습니다.",
          [],
          400
        );
      }

      let supabase;
      try {
        supabase = getSupabaseSignatureVoiceAdminClient();
      } catch (err) {
        console.error("[supabase-storage-config-error]", err);
        return errorResponse(res, "SERVER_ERROR", "시그니처 보이스 저장소 설정이 누락되었습니다.", [], 500);
      }

      const storagePath = buildSignatureVoiceStoragePath(req.user!.userId, file);
      const { data, error } = await supabase.storage
        .from(SIGNATURE_VOICE_BUCKET)
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          cacheControl: "31536000",
          upsert: false,
        });

      if (error || !data) {
        console.error("[supabase-signature-voice-upload-error]", error);
        return errorResponse(res, "SERVER_ERROR", "시그니처 보이스 업로드에 실패했습니다.", [], 500);
      }

      const signedUrl = await createSignatureVoiceSignedUrl(data.path);

      return successResponse(
        res,
        { url: signedUrl, path: data.path },
        "시그니처 보이스가 업로드되었습니다.",
        201
      );
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/freelancer/signature-voice - 현재 시그니처 보이스 삭제
router.delete(
  "/signature-voice",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
        select: { id: true, signature_voice_path: true },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프리랜서 프로필을 찾을 수 없습니다.", [], 404);
      }

      if (!profile.signature_voice_path) {
        return successResponse(res, null, "삭제할 시그니처 보이스가 없습니다.");
      }

      if (!isOwnSignatureVoicePath(req.user!.userId, profile.signature_voice_path)) {
        return errorResponse(res, "FORBIDDEN", "삭제할 수 없는 시그니처 보이스입니다.", [], 403);
      }

      try {
        await deleteStoredSignatureVoice(profile.signature_voice_path);
      } catch (err) {
        console.error("[supabase-signature-voice-delete-error]", err);
        return errorResponse(res, "SERVER_ERROR", "시그니처 보이스 삭제에 실패했습니다.", [], 500);
      }

      await prisma.freelancerProfile.update({
        where: { id: profile.id },
        data: {
          signature_voice_path: null,
          signature_voice_url: null,
        },
      });

      return successResponse(res, null, "시그니처 보이스가 삭제되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/freelancer/profile-image - 현재 프로필 이미지 삭제
router.delete(
  "/profile-image",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
        select: { id: true, profile_image_path: true },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프리랜서 프로필을 찾을 수 없습니다.", [], 404);
      }

      if (!profile.profile_image_path) {
        return successResponse(res, null, "삭제할 프로필 이미지가 없습니다.");
      }

      if (!isOwnProfileImagePath(req.user!.userId, profile.profile_image_path)) {
        return errorResponse(res, "FORBIDDEN", "삭제할 수 없는 프로필 이미지입니다.", [], 403);
      }

      try {
        await deleteStoredProfileImage(profile.profile_image_path);
      } catch (err) {
        console.error("[supabase-profile-image-delete-error]", err);
        return errorResponse(res, "SERVER_ERROR", "프로필 이미지 삭제에 실패했습니다.", [], 500);
      }

      await prisma.freelancerProfile.update({
        where: { id: profile.id },
        data: {
          profile_image_path: null,
          profile_image_url: null,
        },
      });

      return successResponse(res, null, "프로필 이미지가 삭제되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/freelancer/profile - 등록 신청
router.post(
  "/profile",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = profileSchema.parse(req.body);

      if (!assertOwnProfileImagePath(req, res, body.profile_image_path)) return;
      if (body.signature_voice_path && !assertOwnSignatureVoicePath(req, res, body.signature_voice_path)) return;

      const existing = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
        select: { profile_image_path: true, signature_voice_path: true },
      });

      if (!existing) {
        return errorResponse(res, "NOT_FOUND", "프리랜서 프로필을 찾을 수 없습니다.", [], 404);
      }

      const previousProfileImagePath = existing.profile_image_path;
      const previousSignatureVoicePath = existing.signature_voice_path;
      const signatureVoicePath = body.signature_voice_path ?? existing.signature_voice_path;

      const profile = await prisma.freelancerProfile.update({
        where: { user_id: req.user!.userId },
        data: {
          ...body,
          profile_image_url: null,
          profile_image_path: body.profile_image_path,
          signature_voice_url: null,
          signature_voice_path: signatureVoicePath,
          status: "pending_review",
        },
      });

      if (
        previousProfileImagePath &&
        previousProfileImagePath !== body.profile_image_path &&
        isOwnProfileImagePath(req.user!.userId, previousProfileImagePath)
      ) {
        void tryDeleteStoredProfileImage(previousProfileImagePath);
      }

      if (
        previousSignatureVoicePath &&
        previousSignatureVoicePath !== signatureVoicePath &&
        isOwnSignatureVoicePath(req.user!.userId, previousSignatureVoicePath)
      ) {
        void tryDeleteStoredSignatureVoice(previousSignatureVoicePath);
      }

      const responseProfileWithImage = await attachSignedProfileImageUrl(profile);
      const responseProfile = await attachSignedSignatureVoiceUrl(responseProfileWithImage);

      return successResponse(res, responseProfile, "등록 신청이 완료되었습니다. 관리자 검수 후 승인됩니다.", 201);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/freelancer/profile
router.get(
  "/profile",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
        include: {
          portfolios: {
            orderBy: [{ is_representative: "desc" }, { created_at: "desc" }],
          },
        },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프로필을 찾을 수 없습니다.", [], 404);
      }

      const responseProfileWithImage = await attachSignedProfileImageUrl(profile);
      const responseProfile = await attachSignedSignatureVoiceUrl(responseProfileWithImage);

      return successResponse(res, responseProfile);
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/freelancer/profile
router.patch(
  "/profile",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = profileSchema.parse(req.body);

      if (!assertOwnProfileImagePath(req, res, body.profile_image_path)) return;
      if (body.signature_voice_path && !assertOwnSignatureVoicePath(req, res, body.signature_voice_path)) return;

      const existing = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
        select: { profile_image_path: true, signature_voice_path: true },
      });

      if (!existing) {
        return errorResponse(res, "NOT_FOUND", "프리랜서 프로필을 찾을 수 없습니다.", [], 404);
      }

      const previousProfileImagePath = existing.profile_image_path;
      const previousSignatureVoicePath = existing.signature_voice_path;
      const signatureVoicePath = body.signature_voice_path ?? existing.signature_voice_path;

      const profile = await prisma.freelancerProfile.update({
        where: { user_id: req.user!.userId },
        data: {
          ...body,
          profile_image_url: null,
          profile_image_path: body.profile_image_path,
          signature_voice_url: null,
          signature_voice_path: signatureVoicePath,
        },
      });

      if (
        previousProfileImagePath &&
        previousProfileImagePath !== body.profile_image_path &&
        isOwnProfileImagePath(req.user!.userId, previousProfileImagePath)
      ) {
        void tryDeleteStoredProfileImage(previousProfileImagePath);
      }

      if (
        previousSignatureVoicePath &&
        previousSignatureVoicePath !== signatureVoicePath &&
        isOwnSignatureVoicePath(req.user!.userId, previousSignatureVoicePath)
      ) {
        void tryDeleteStoredSignatureVoice(previousSignatureVoicePath);
      }

      const responseProfileWithImage = await attachSignedProfileImageUrl(profile);
      const responseProfile = await attachSignedSignatureVoiceUrl(responseProfileWithImage);

      return successResponse(res, responseProfile, "프로필이 수정되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// ─── 포트폴리오 ─────────────────────────────────────────────

// POST /api/freelancer/portfolio
router.post(
  "/portfolio",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = portfolioSchema.parse(req.body);

      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프로필을 찾을 수 없습니다.", [], 404);
      }

      const portfolio = await prisma.portfolio.create({
        data: {
          ...body,
          thumbnail_url: body.thumbnail_url ?? null,
          freelancer_id: profile.id,
        },
      });

      return successResponse(res, portfolio, "포트폴리오가 등록되었습니다.", 201);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/freelancer/portfolio
router.get(
  "/portfolio",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프로필을 찾을 수 없습니다.", [], 404);
      }

      const portfolios = await prisma.portfolio.findMany({
        where: { freelancer_id: profile.id },
        orderBy: [{ is_representative: "desc" }, { created_at: "desc" }],
      });

      return successResponse(res, portfolios);
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/freelancer/portfolio/:id
router.patch(
  "/portfolio/:id",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = portfolioSchema.partial().parse(req.body);

      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프로필을 찾을 수 없습니다.", [], 404);
      }

      const existing = await prisma.portfolio.findFirst({
        where: { id: req.params.id, freelancer_id: profile.id },
      });

      if (!existing) {
        return errorResponse(res, "NOT_FOUND", "포트폴리오를 찾을 수 없습니다.", [], 404);
      }

      const portfolio = await prisma.portfolio.update({
        where: { id: req.params.id },
        data: {
          ...body,
          thumbnail_url: body.thumbnail_url ?? undefined,
        },
      });

      return successResponse(res, portfolio, "포트폴리오가 수정되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/freelancer/portfolio/:id
router.delete(
  "/portfolio/:id",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프로필을 찾을 수 없습니다.", [], 404);
      }

      const existing = await prisma.portfolio.findFirst({
        where: { id: req.params.id, freelancer_id: profile.id },
      });

      if (!existing) {
        return errorResponse(res, "NOT_FOUND", "포트폴리오를 찾을 수 없습니다.", [], 404);
      }

      await prisma.portfolio.delete({ where: { id: req.params.id } });

      return successResponse(res, null, "포트폴리오가 삭제되었습니다.");
    } catch (err) {
      next(err);
    }
  }
);

// ─── 전달받은 요청 목록 ──────────────────────────────────────

// GET /api/freelancer/requests
router.get(
  "/requests",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);

      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프로필을 찾을 수 없습니다.", [], 404);
      }

      const where = { freelancer_id: profile.id };

      const [items, total] = await Promise.all([
        prisma.recommendation.findMany({
          where,
          skip,
          take: limit,
          orderBy: { created_at: "desc" },
          include: {
            request: {
              select: {
                id: true,
                event_title: true,
                event_type: true,
                event_date: true,
                region: true,
                budget_min: true,
                budget_max: true,
                status: true,
              },
            },
          },
        }),
        prisma.recommendation.count({ where }),
      ]);

      return listResponse(res, items, total, page, limit);
    } catch (err) {
      next(err);
    }
  }
);

// ─── 견적 제안 ────────────────────────────────────────────────

// POST /api/freelancer/quotes
router.post(
  "/quotes",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = quoteSchema.parse(req.body);

      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프리랜서 프로필을 찾을 수 없습니다.", [], 404);
      }

      const recommendation = await prisma.recommendation.findFirst({
        where: {
          request_id: body.request_id,
          freelancer_id: profile.id,
          status: { in: ["sent", "viewed"] },
        },
        include: { request: true },
      });

      if (!recommendation) {
        return errorResponse(
          res,
          "FORBIDDEN",
          "관리자가 전달한 요청서에만 견적을 제안할 수 있습니다.",
          [],
          403
        );
      }

      if (["canceled", "disputed", "completed", "reviewed", "booked"].includes(recommendation.request.status)) {
        return errorResponse(res, "CONFLICT", "현재 상태의 요청서에는 견적을 제안할 수 없습니다.", [], 409);
      }

      const existing = await prisma.quote.findFirst({
        where: {
          request_id: body.request_id,
          freelancer_id: profile.id,
          status: { in: ["proposed", "accepted"] },
        },
      });

      if (existing) {
        return errorResponse(res, "CONFLICT", "이미 해당 요청에 견적을 제안하셨습니다.", [], 409);
      }

      const platformFee = Math.floor(body.price * 0.1);
      const totalPrice = body.price + platformFee;

      const quote = await prisma.quote.create({
        data: {
          request_id: body.request_id,
          freelancer_id: profile.id,
          quoted_by: req.user!.userId,
          price: body.price,
          platform_fee: platformFee,
          total_price: totalPrice,
          included_services: body.included_services,
          script_included: body.script_included,
          rehearsal_included: body.rehearsal_included,
          travel_fee_included: body.travel_fee_included,
          message: body.message,
          valid_until: body.valid_until ? new Date(body.valid_until) : null,
          status: "proposed",
        },
      });

      return successResponse(res, quote, "견적이 제안되었습니다.", 201);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/freelancer/settlements
router.get(
  "/settlements",
  authenticate,
  requireFreelancer,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);

      const profile = await prisma.freelancerProfile.findUnique({
        where: { user_id: req.user!.userId },
      });

      if (!profile) {
        return errorResponse(res, "NOT_FOUND", "프로필을 찾을 수 없습니다.", [], 404);
      }

      const where = { freelancer_id: profile.id };

      const [items, total] = await Promise.all([
        prisma.booking.findMany({
          where,
          skip,
          take: limit,
          orderBy: { created_at: "desc" },
          select: {
            id: true,
            event_title: true,
            event_date: true,
            final_price: true,
            platform_fee: true,
            freelancer_amount: true,
            booking_status: true,
            payment_status: true,
            settlement_status: true,
          },
        }),
        prisma.booking.count({ where }),
      ]);

      return listResponse(res, items, total, page, limit);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
