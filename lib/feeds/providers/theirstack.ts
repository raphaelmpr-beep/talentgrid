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
      if (input.query) url.searchParams.set("q", input.query);
      if (input.postedSince) url.searchParams.set("posted_since", input.postedSince);
      if (input.limit) url.searchParams.set("limit", String(input.limit));
      if (input.page) url.searchParams.set("page", String(input.page));

      const res = await fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          authorization: `Bearer ${config.credentials.apiKey}`,
          accept: "application/json",
        },
      });
      if (!res.ok) {
        throw new TheirStackRequestError(res.status, await safeText(res));
      }
      const body = (await res.json()) as Partial<TheirStackSearchResult> & {
        jobs?: TheirStackJob[];
      };
      return {
        jobs: Array.isArray(body.jobs) ? body.jobs : [],
        total: typeof body.total === "number" ? body.total : undefined,
        page: typeof body.page === "number" ? body.page : input.page,
        nextPage: typeof body.nextPage === "number" ? body.nextPage : null,
      };
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
