// Shared, pure classifiers for normalising job postings into the role_category
// and domain_category buckets the architecture uses. Kept dependency-free so
// the ingestion cron, workers, and dry-runs can all persist the same values
// the read-side query path expects.

export const ROLE_CATEGORIES = [
  "frontend",
  "backend",
  "fullstack",
  "devops",
  "data",
  "mobile",
  "ml",
  "engineer",
] as const;

export const DOMAIN_CATEGORIES = [
  "hr",
  "sales",
  "finance",
  "robotics",
  "healthcare",
  "ai",
] as const;

export type RoleCategory = (typeof ROLE_CATEGORIES)[number];
export type DomainCategory = (typeof DOMAIN_CATEGORIES)[number];

export function classifyRoleCategory(
  title: string | null | undefined,
  description?: string | null
): RoleCategory | null {
  const t = `${title ?? ""} ${description ?? ""}`.toLowerCase();
  if (!t.trim()) return null;

  if (/full[\s-]?stack/.test(t)) return "fullstack";
  if (/frontend|front[\s-]end/.test(t)) return "frontend";
  if (/backend|back[\s-]end/.test(t)) return "backend";
  if (/machine\s+learning|deep\s+learning|\bnlp\b|computer\s+vision|ml\s+engineer|ai\s+engineer/.test(t)) return "ml";
  if (/data\s+(engineer|scientist|analyst|science)|analytics\s+engineer/.test(t)) return "data";
  if (/devops|dev[\s-]ops|site\s+reliability|\bsre\b|infrastructure\s+eng|platform\s+eng|cloud\s+eng/.test(t)) return "devops";
  if (/\bmobile\b|\bios\b|\bandroid\b|react\s+native/.test(t)) return "mobile";
  if (/software\s+engineer|software\s+developer|\bengineer\b|\bdeveloper\b/.test(t)) return "engineer";

  return null;
}

export function classifyDomainCategory(
  title: string | null | undefined,
  description?: string | null,
  companyContext?: string | null
): DomainCategory | null {
  const t = `${title ?? ""} ${description ?? ""} ${companyContext ?? ""}`.toLowerCase();
  if (!t.trim()) return null;

  if (/\bhr\b|human\s+resources|recruit|talent\s+acquisition/.test(t)) return "hr";
  if (/\bsales\b|account\s+executive|\bbdr\b|\bsdr\b|\bcrm\b/.test(t)) return "sales";
  if (/finance|fintech|banking|payments|accounting/.test(t)) return "finance";
  if (/robotics|\brobot\b|\bdrone\b|autonomous/.test(t)) return "robotics";
  if (/healthcare|health\s+care|medical|medtech|clinical|pharma/.test(t)) return "healthcare";
  if (/\bai\b|artificial\s+intelligence|machine\s+learning|\bml\b|\bllm\b|\bnlp\b/.test(t)) return "ai";

  return null;
}

// Map a numeric annual-revenue estimate (USD) onto the canonical band label
// used across the API and companies.revenue_band column.
export function revenueBandFromAmount(amount: number | null | undefined): string | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  if (amount < 50_000_000) return "lt_50m";
  if (amount < 100_000_000) return "50m_100m";
  if (amount < 600_000_000) return "100m_600m";
  if (amount < 1_000_000_000) return "600m_1b";
  return "gt_1b";
}
