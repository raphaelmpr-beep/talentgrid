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

// `targetUrl` is the canonical per-request URL field. When supplied the
// enrichment client POSTs directly to that URL instead of resolving a path
// against ENRICHMENT_API_BASE_URL. This is how callers point at a specific
// champion/profile/company page (LinkedIn, the company's own site, …) whose
// URL is only known at request time.
export type CompanyEnrichmentInput = {
  domain?: string;
  name: string;
  targetUrl?: string;
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
  // Canonical per-request URL (see CompanyEnrichmentInput.targetUrl).
  targetUrl?: string;
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

  // Resolve the final endpoint URL for a request. `targetUrl` (per-request)
  // wins; otherwise we fall back to `${ENRICHMENT_API_BASE_URL}/${path}`.
  // If neither is available we throw a structured error so callers can
  // surface a clear "missing target url" response instead of a generic 500.
  function resolveEndpoint(path: string, targetUrl: string | undefined, baseUrl: string | undefined): string {
    if (targetUrl && targetUrl.trim().length > 0) {
      try {
        return new URL(targetUrl).toString();
      } catch {
        throw new EnrichmentTargetUrlError(`invalid targetUrl: ${targetUrl}`);
      }
    }
    if (!baseUrl) {
      throw new EnrichmentTargetUrlError(
        "no targetUrl supplied and ENRICHMENT_API_BASE_URL is not configured"
      );
    }
    const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
    return new URL(path.replace(/^\//, ""), base).toString();
  }

  async function call<T>(path: string, targetUrl: string | undefined, body: unknown): Promise<T> {
    const creds = ensureReady();
    const endpoint = resolveEndpoint(path, targetUrl, creds.baseUrl);
    const res = await fetchImpl(endpoint, {
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
      const { targetUrl, ...payload } = input;
      const data = await call<{
        revenue?: RevenueEstimate;
        industry?: string;
        size?: string;
        raw?: Record<string, unknown>;
      }>("companies/enrich", targetUrl, payload);
      return {
        revenue: data.revenue,
        industry: data.industry,
        size: data.size,
        raw: data.raw,
      };
    },
    async enrichPoc(input) {
      const { targetUrl, ...payload } = input;
      const data = await call<{ candidates?: PocCandidate[] }>(
        "pocs/enrich",
        targetUrl,
        payload
      );
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

// Thrown when neither a per-request targetUrl nor a fallback
// ENRICHMENT_API_BASE_URL is available. Routes surface this as a 400/422
// rather than treating the provider as un-configured.
export class EnrichmentTargetUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrichmentTargetUrlError";
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
