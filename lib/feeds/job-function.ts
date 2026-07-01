// Job-function classifier for the Aging Role Market Value feature.
//
// This is intentionally additive — it re-uses the existing role_category
// values (from classify.ts) to produce a user-friendly function label and
// extends them where needed. No existing logic is changed.
//
// The mapping is a plain lookup so callers can import JOB_FUNCTIONS to build
// filter UIs without needing to know the underlying role_category values.

export const JOB_FUNCTIONS = [
  { value: "software_engineering", label: "Software Engineering" },
  { value: "data_science",         label: "Data Science" },
  { value: "ai_ml",                label: "AI / Machine Learning" },
  { value: "data_engineering",     label: "Data Engineering" },
  { value: "cybersecurity",        label: "Cybersecurity" },
  { value: "product",              label: "Product" },
  { value: "cloud_infrastructure", label: "Cloud / Infrastructure" },
  { value: "devops_sre",           label: "DevOps / SRE" },
] as const;

export type JobFunctionValue = (typeof JOB_FUNCTIONS)[number]["value"];

// Maps an existing role_category (from classify.ts) to one or more
// JobFunctionValues. A single role_category can cover multiple functions
// (e.g. "ml" covers both ai_ml and data_science in some titles) so the
// resolution is title-aware when needed.
//
// Called server-side at query time — no DB columns modified.
export function roleCategoryToJobFunction(
  roleCategory: string | null | undefined,
  title: string | null | undefined
): JobFunctionValue | null {
  const t = (title ?? "").toLowerCase();
  const cat = (roleCategory ?? "").toLowerCase();

  // Fine-grained title checks first so they override the coarser category.
  if (/cyber|security\s+eng|appsec|devsecops|penetration|infosec/.test(t))
    return "cybersecurity";
  if (/data\s+engineer|etl|pipeline\s+eng|analytics\s+eng/.test(t))
    return "data_engineering";
  if (
    /machine\s+learning|deep\s+learning|\bnlp\b|computer\s+vision|llm|generative|ai\s+eng|ml\s+eng/.test(t)
  )
    return "ai_ml";
  if (/data\s+scien|research\s+scien/.test(t)) return "data_science";
  if (/product\s+manager|product\s+owner|\bpm\b/.test(t)) return "product";
  if (/cloud\s+eng|site\s+reliability|\bsre\b|platform\s+eng|infrastructure\s+eng/.test(t))
    return "cloud_infrastructure";
  if (/devops|dev[\s-]ops/.test(t)) return "devops_sre";

  // Fall back to the stored role_category.
  switch (cat) {
    case "ml":     return "ai_ml";
    case "data":   return "data_science";
    case "devops": return "devops_sre";
    case "frontend":
    case "backend":
    case "fullstack":
    case "mobile":
    case "engineer": return "software_engineering";
    default:       return null;
  }
}

// Resolve which job functions a raw title maps to — used in the API when
// role_category may not yet be stored (newly ingested rows).
export function classifyJobFunction(
  title: string | null | undefined,
  roleCategory?: string | null
): JobFunctionValue | null {
  return roleCategoryToJobFunction(roleCategory, title);
}
