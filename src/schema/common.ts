import { z } from "zod";

export const IsoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Expected ISO 8601 datetime string",
  });

export const SlugId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-_.]*$/, {
    message: "Expected lowercase slug: letters, digits, '-', '_', '.'",
  });

export const ShortText = z.string().min(1).max(500);
export const LongText = z.string().min(1).max(20000);
