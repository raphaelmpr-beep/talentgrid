import { theirStackConfig, type ProviderConfig } from "@/lib/feeds/config";

// Subset of the TheirStack job payload we map into our schema.
// Mirrors the shape already accepted by app/api/webhooks/theirstack/route.ts
// so the webhook and polling paths share one normaliser.
export type TheirStackJob = {
  external_id: string;
  title: string;
  description?: string;
  url?: string;
  location?: string;
  remote?: boolean;
  employment_type?: string;
  seniority?: string;
  salary_min?: number;
  salary_max?: number;
  posted_at?: string;
  company: {
    name: string;
    domain?: string;
    website?: string;
    industry?: string;
    size?: string;
    location?: string;
    logo_url?: string;
  };
};

export type TheirStackSearchInput = {
  // Forward-compatible search filters; intentionally permissive — TheirStack's
  // public schema may evolve and we don't want to gate the scaffold on it.
  query?: string;
  postedSince?: string; // ISO date
  limit?: number;
  page?: number;
  // Optional pass-through filters that map directly onto the TheirStack
  // POST /jobs/search JSON body. Callers can supply these when they need
  // tighter targeting than the conservative defaults.
  postedAtMaxAgeDays?: number;
  jobTitleOr?: string[];
  jobCountryCodeOr?: string[];
  companyDomainOr?: string[];
};

export type TheirStackSearchResult = {
  jobs: TheirStackJob[];
  total?: number;
  page?: number;
  nextPage?: number | null;
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type TheirStackClient = {
  config: ProviderConfig;
  searchJobs(input: TheirStackSearchInput): Promise<TheirStackSearchResult>;
};

export type TheirStackClientOptions = {
  fetch?: FetchLike;
  config?: ProviderConfig;
};

export function createTheirStackClient(
  options: TheirStackClientOptions = {}
): TheirStackClient {
  const config = options.config ?? theirStackConfig();
  const fetchImpl: FetchLike = options.fetch ?? globalThis.fetch.bind(globalThis);

  return {
    config,
    async searchJobs(input) {
      if (!config.configured || !config.credentials) {
        throw new TheirStackNotConfiguredError(config.missing);
      }
      const baseUrl = config.meta?.baseUrl ?? "https://api.theirstack.com/v1";
      const url = new URL("jobs/search", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");

      const requestBody = buildSearchBody(input);

      const res = await fetchImpl(url.toString(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.credentials.apiKey}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
      if (!res.ok) {
        throw new TheirStackRequestError(res.status, await safeText(res));
      }
      const raw = (await res.json()) as unknown;
      return parseSearchResponse(raw, input);
    },
  };
}

export class TheirStackNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`TheirStack not configured: missing ${missing.join(", ")}`);
    this.name = "TheirStackNotConfiguredError";
  }
}

export class TheirStackRequestError extends Error {
  constructor(public status: number, public body: string) {
    super(`TheirStack request failed (${status})`);
    this.name = "TheirStackRequestError";
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

// Conservative defaults for TalentGrid. TheirStack's POST /jobs/search will
// happily return tens of thousands of jobs if you don't constrain it, so we
// pin the batch size to the feed default (20, capped at 100) and target
// recent US postings unless the caller overrides.
const DEFAULT_FEED_LIMIT = 20;
const MAX_FEED_LIMIT = 100;
const DEFAULT_POSTED_AT_MAX_AGE_DAYS = 7;
const DEFAULT_COUNTRY_CODES = ["US"];

export function buildSearchBody(
  input: TheirStackSearchInput
): Record<string, unknown> {
  const limit = clampLimit(input.limit);
  const body: Record<string, unknown> = { limit };

  if (typeof input.page === "number" && input.page > 1) {
    // TheirStack uses page (1-indexed) — keep both knobs symmetric.
    body.page = input.page;
  }

  const maxAgeDays = resolveMaxAgeDays(input);
  if (typeof maxAgeDays === "number") {
    body.posted_at_max_age_days = maxAgeDays;
  }

  if (input.jobTitleOr && input.jobTitleOr.length > 0) {
    body.job_title_or = input.jobTitleOr;
  } else if (input.query) {
    // Best-effort: treat free-text `query` as a title token match.
    body.job_title_or = [input.query];
  }

  const countries = input.jobCountryCodeOr ?? DEFAULT_COUNTRY_CODES;
  if (countries.length > 0) {
    body.job_country_code_or = countries;
  }

  if (input.companyDomainOr && input.companyDomainOr.length > 0) {
    body.company_domain_or = input.companyDomainOr;
  }

  return body;
}

function clampLimit(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_FEED_LIMIT;
  }
  return Math.min(Math.floor(requested), MAX_FEED_LIMIT);
}

function resolveMaxAgeDays(input: TheirStackSearchInput): number | undefined {
  if (typeof input.postedAtMaxAgeDays === "number" && input.postedAtMaxAgeDays > 0) {
    return Math.floor(input.postedAtMaxAgeDays);
  }
  if (input.postedSince) {
    const since = Date.parse(input.postedSince);
    if (!Number.isNaN(since)) {
      const days = Math.ceil((Date.now() - since) / (1000 * 60 * 60 * 24));
      if (days > 0) return days;
    }
  }
  return DEFAULT_POSTED_AT_MAX_AGE_DAYS;
}

// TheirStack's POST /jobs/search returns `{ data: [...], metadata: {...} }`
// rather than the `{ jobs: [...] }` shape the scaffold originally assumed.
// Be defensive — accept either, and ignore fields we don't recognise.
export function parseSearchResponse(
  raw: unknown,
  input: TheirStackSearchInput
): TheirStackSearchResult {
  const body = (raw ?? {}) as Record<string, unknown>;
  const rawJobs = Array.isArray(body.data)
    ? body.data
    : Array.isArray(body.jobs)
      ? body.jobs
      : [];
  const jobs = rawJobs
    .map((item) => normaliseJob(item))
    .filter((j): j is TheirStackJob => j !== null);

  const metadata =
    body.metadata && typeof body.metadata === "object"
      ? (body.metadata as Record<string, unknown>)
      : undefined;
  const total =
    typeof body.total === "number"
      ? body.total
      : typeof metadata?.total_results === "number"
        ? (metadata.total_results as number)
        : undefined;

  return {
    jobs,
    total,
    page: typeof body.page === "number" ? (body.page as number) : input.page,
    nextPage: typeof body.nextPage === "number" ? (body.nextPage as number) : null,
  };
}

function normaliseJob(raw: unknown): TheirStackJob | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const externalId = pickString(r, ["external_id", "id", "job_id"]);
  const title = pickString(r, ["title", "job_title", "name"]);
  if (!externalId || !title) return null;

  const companyRaw = (r.company && typeof r.company === "object"
    ? (r.company as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const companyName =
    pickString(companyRaw, ["name", "company_name"]) ??
    pickString(r, ["company_name", "company"]);
  if (!companyName) return null;

  return {
    external_id: externalId,
    title,
    description: pickString(r, ["description", "job_description"]),
    url: pickString(r, ["url", "final_url", "source_url"]),
    location: pickString(r, ["location", "job_location"]),
    remote: pickBool(r, ["remote", "is_remote", "remote_work_allowed"]),
    employment_type: pickString(r, ["employment_type", "employment_statuses"]),
    seniority: pickString(r, ["seniority", "seniority_level"]),
    salary_min: pickNumber(r, ["salary_min", "min_annual_salary"]),
    salary_max: pickNumber(r, ["salary_max", "max_annual_salary"]),
    posted_at: pickString(r, ["posted_at", "date_posted", "date_added"]),
    company: {
      name: companyName,
      domain: pickString(companyRaw, ["domain", "company_domain"]) ?? undefined,
      website: pickString(companyRaw, ["website", "url"]) ?? undefined,
      industry: pickString(companyRaw, ["industry"]) ?? undefined,
      size: pickString(companyRaw, ["size", "employee_count_range"]) ?? undefined,
      location: pickString(companyRaw, ["location", "hq_location"]) ?? undefined,
      logo_url: pickString(companyRaw, ["logo_url", "logo"]) ?? undefined,
    },
  };
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

function pickNumber(
  obj: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function pickBool(
  obj: Record<string, unknown>,
  keys: string[]
): boolean | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "boolean") return v;
  }
  return undefined;
}

// Mapping helpers — kept pure so unit tests / dry-runs can exercise them
// without hitting Supabase or BullMQ.

export type MappedCompany = {
  name: string;
  domain: string | null;
  website: string | null;
  industry: string | null;
  size: string | null;
  location: string | null;
  logo_url: string | null;
  is_hiring: true;
};

export type MappedRole = {
  external_id: string;
  title: string;
  description: string | null;
  location: string | null;
  remote: boolean;
  employment_type: string | null;
  seniority: string | null;
  salary_min: number | null;
  salary_max: number | null;
  url: string | null;
  source: "theirstack";
  posted_at: string | null;
  metadata: { external_id: string };
  is_active: true;
};

export function mapJobToCompany(job: TheirStackJob): MappedCompany {
  return {
    name: job.company.name,
    domain: job.company.domain ?? null,
    website: job.company.website ?? null,
    industry: job.company.industry ?? null,
    size: job.company.size ?? null,
    location: job.company.location ?? null,
    logo_url: job.company.logo_url ?? null,
    is_hiring: true,
  };
}

export function mapJobToRole(job: TheirStackJob): MappedRole {
  return {
    external_id: job.external_id,
    title: job.title,
    description: job.description ?? null,
    location: job.location ?? null,
    remote: job.remote ?? false,
    employment_type: job.employment_type ?? null,
    seniority: job.seniority ?? null,
    salary_min: job.salary_min ?? null,
    salary_max: job.salary_max ?? null,
    url: job.url ?? null,
    source: "theirstack",
    posted_at: job.posted_at ?? null,
    metadata: { external_id: job.external_id },
    is_active: true,
  };
}
