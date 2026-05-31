import { z } from "zod";

export const optionalHttpsUrl = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z
    .string()
    .url("유효한 URL을 입력해 주세요.")
    .max(2048, "URL은 2048자 이하로 입력해 주세요.")
    .refine((value) => value.startsWith("https://"), "https:// URL만 허용됩니다.")
    .optional()
);

export const requiredHttpsUrl = z
  .string()
  .url("유효한 URL을 입력해 주세요.")
  .max(2048, "URL은 2048자 이하로 입력해 주세요.")
  .refine((value) => value.startsWith("https://"), "https:// URL만 허용됩니다.");

export const shortText = (max = 100) => z.string().trim().min(1).max(max);

export const optionalShortText = (max = 1000) =>
  z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.string().trim().max(max).optional()
  );

export const stringArray = (maxItems = 20, maxItemLength = 50) =>
  z.array(z.string().trim().min(1).max(maxItemLength)).max(maxItems).default([]);

export const optionalStringArray = (maxItems = 20, maxItemLength = 50) =>
  z.array(z.string().trim().min(1).max(maxItemLength)).max(maxItems).optional();

export const timeHHmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "시간은 HH:mm 형식으로 입력해 주세요.");

export const eventDateString = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "유효한 날짜를 입력해 주세요.")
  .refine((value) => {
    const input = new Date(value);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return input >= today;
  }, "행사일은 오늘 이후 날짜로 입력해 주세요.");

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export const requestStatusQuerySchema = z.object({
  status: z
    .enum([
      "submitted",
      "reviewing",
      "recommending",
      "recommended",
      "consulting",
      "booked",
      "completed",
      "reviewed",
      "canceled",
      "disputed",
    ])
    .optional(),
});
