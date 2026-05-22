import { z } from "zod";

export const companyCreateSchema = z.object({
  name: z.string().min(1).max(200),
  domain: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).optional(),
  industry: z.string().max(120).optional(),
  size: z.string().max(50).optional(),
  location: z.string().max(200).optional(),
  logoUrl: z.string().url().optional(),
  website: z.string().url().optional(),
  isHiring: z.boolean().optional().default(false),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const companyUpdateSchema = companyCreateSchema.partial();

export const companyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  isHiring: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  q: z.string().max(200).optional(),
});

export type CompanyCreate = z.infer<typeof companyCreateSchema>;
export type CompanyUpdate = z.infer<typeof companyUpdateSchema>;
export type CompanyQuery = z.infer<typeof companyQuerySchema>;
