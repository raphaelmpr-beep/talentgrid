import { z } from "zod";

export const roleCreateSchema = z.object({
  companyId: z.string().uuid(),
  title: z.string().min(1).max(300),
  description: z.string().max(20000).optional(),
  location: z.string().max(200).optional(),
  remote: z.boolean().optional().default(false),
  employmentType: z.string().max(50).optional(),
  seniority: z.string().max(50).optional(),
  salaryMin: z.number().int().nonnegative().optional(),
  salaryMax: z.number().int().nonnegative().optional(),
  url: z.string().url().optional(),
  source: z.string().max(120).optional(),
  isActive: z.boolean().optional().default(true),
  ghostScore: z.number().int().min(0).max(100).optional().default(0),
  postedAt: z.coerce.date().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const roleUpdateSchema = roleCreateSchema.partial();

export const roleQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  isActive: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  maxGhostScore: z.coerce.number().int().min(0).max(100).optional(),
  companyId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
});

export type RoleCreate = z.infer<typeof roleCreateSchema>;
export type RoleUpdate = z.infer<typeof roleUpdateSchema>;
export type RoleQuery = z.infer<typeof roleQuerySchema>;
