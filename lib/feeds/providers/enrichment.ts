import { enrichmentConfig, type ProviderConfig } from "@/lib/feeds/config";
import type { FetchLike } from "@/lib/feeds/providers/theirstack";

// Revenue convention is the canonical schema documented in
// supabase/migrations/001_initial_schema.sql:
//   companies.metadata.annual_revenue : integer USD point estimate
//   companies.metadata.revenue_min    : integer USD lower bound (range)
//   companies.metadata.revenue_max    : integer USD upper bound (range)
export type RevenueEstimate = {
  annualRevenue?: number;
  revenueMin?: number;
  revenueMax?: number;
  currency?: "USD";
  confidence?: "low" | "medium" | "high";
  source?: string;
};

export type CompanyEnrichmentInput = {
  domain?: string;
  name: string;
};

export type CompanyEnrichmentResult = {
  revenue?: RevenueEstimate;
  industry?: string;
  size?: string;
  // Free-form provider metadata persisted under companies.metadata.enrichment.
  raw?: Record<string, unknown>;
};

export type PocCandidate = {
  name: string;
  title?: string;
  email?: string;
  linkedin?: string;
  phone?: string;
  tags?: string[];
};

export type PocEnrichmentInput = {
  companyDomain?: string;
  companyName: string;
  // Optional role context — providers may use it to score relevance.
  roleTitle?: string;
};

export type PocEnrichmentResult = {
  candidates: PocCandidate[];
};

export type EnrichmentClient = {
  config: ProviderConfig;
  enrichCompany(input: CompanyEnrichmentInput): Promise<CompanyEnrichmentResult>;
  enrichPoc(input: PocEnrichmentInput): Promise<PocEnrichmentResult>;
};

export type EnrichmentClientOptions = {
  fetch?: FetchLike;
  config?: ProviderConfig;
};

export function createEnrichmentClient(
  options: EnrichmentClientOptions = {}
): EnrichmentClient {
  const config = options.config ?? enrichmentConfig();
  const fetchImpl: FetchLike = options.fetch ?? globalThis.fetch.bind(globalThis);

  function ensureReady() {
    if (!config.configured || !config.credentials) {
      throw new EnrichmentNotConfiguredError(config.missing);
    }
    return config.credentials;
  }

  async function call<T>(path: string, body: unknown): Promise<T> {
    const creds = ensureReady();
    const url = new URL(path.replace(/^\//, ""), creds.baseUrl.endsWith("/") ? creds.baseUrl : creds.baseUrl + "/");
    const res = await fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${creds.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new EnrichmentRequestError(res.status, await safeText(res));
    }
    return (await res.json()) as T;
  }

  return {
    config,
    async enrichCompany(input) {
      const data = await call<{
        revenue?: RevenueEstimate;
        industry?: string;
        size?: string;
        raw?: Record<string, unknown>;
      }>("companies/enrich", input);
      return {
        revenue: data.revenue,
        industry: data.industry,
        size: data.size,
        raw: data.raw,
      };
    },
    async enrichPoc(input) {
      const data = await call<{ candidates?: PocCandidate[] }>("pocs/enrich", input);
      return { candidates: Array.isArray(data.candidates) ? data.candidates : [] };
    },
  };
}

export class EnrichmentNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`Enrichment provider not configured: missing ${missing.join(", ")}`);
    this.name = "EnrichmentNotConfiguredError";
  }
}

export class EnrichmentRequestError extends Error {
  constructor(public status: number, public body: string) {
    super(`Enrichment provider request failed (${status})`);
    this.name = "EnrichmentRequestError";
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

// Merge a RevenueEstimate into an existing companies.metadata jsonb blob
// while preserving the schema-documented keys.
export function applyRevenueToMetadata(
  metadata: Record<string, unknown> | null | undefined,
  revenue: RevenueEstimate | undefined
): Record<string, unknown> {
  const base = { ...(metadata ?? {}) };
  if (!revenue) return base;
  if (typeof revenue.annualRevenue === "number") {
    base.annual_revenue = Math.round(revenue.annualRevenue);
  }
  if (typeof revenue.revenueMin === "number") {
    base.revenue_min = Math.round(revenue.revenueMin);
  }
  if (typeof revenue.revenueMax === "number") {
    base.revenue_max = Math.round(revenue.revenueMax);
  }
  if (revenue.confidence || revenue.source || revenue.currency) {
    base.revenue_meta = {
      confidence: revenue.confidence,
      source: revenue.source,
      currency: revenue.currency ?? "USD",
    };
  }
  return base;
}
