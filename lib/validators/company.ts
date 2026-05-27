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

// Annual revenue is stored on companies.metadata as the canonical key
// `annual_revenue` (USD, integer). When a company reports a range instead
// of a point estimate, `revenue_min`/`revenue_max` may also be present and
// are considered overlapping with the requested window.
export const DEFAULT_MIN_REVENUE = 0;
export const DEFAULT_MAX_REVENUE = 10_000_000_000;
export const COMPANY_ROLE_FAMILIES = [
  "frontend",
  "backend",
  "fullstack",
  "devops",
  "data",
  "mobile",
  "ml",
  "engineer",
] as const;

export const COMPANY_DOMAINS = [
  "hr",
  "sales",
  "finance",
  "robotics",
  "healthcare",
  "ai",
] as const;

function normaliseFamilyAlias(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const v = value.trim().toLowerCase();
  if (v === "engineering") return "engineer";
  return v;
}

export const companyQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).optional(),
    family: z.preprocess(normaliseFamilyAlias, z.enum(COMPANY_ROLE_FAMILIES).optional()),
    role: z.preprocess(normaliseFamilyAlias, z.enum(COMPANY_ROLE_FAMILIES).optional()),
    domain: z.enum(COMPANY_DOMAINS).optional(),
    isHiring: z
      .union([z.literal("true"), z.literal("false")])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
    q: z.string().max(200).optional(),
    minRevenue: z.coerce.number().int().min(0).optional(),
    maxRevenue: z.coerce.number().int().min(0).optional(),
    includeUnknownRevenue: z
      .union([z.literal("true"), z.literal("false")])
      .optional()
      .default("true")
      .transform((v) => v === "true"),
  })
  .refine((v) => {
    if (typeof v.minRevenue !== "number" || typeof v.maxRevenue !== "number") {
      return true;
    }
    return v.minRevenue <= v.maxRevenue;
  }, {
    message: "minRevenue must be less than or equal to maxRevenue",
    path: ["minRevenue"],
  });

export type CompanyCreate = z.infer<typeof companyCreateSchema>;
export type CompanyUpdate = z.infer<typeof companyUpdateSchema>;
export type CompanyQuery = z.infer<typeof companyQuerySchema>;
