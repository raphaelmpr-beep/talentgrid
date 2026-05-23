// Orchestration helpers that the API routes and workers share. Every function
// supports a `dryRun` mode: it performs all read-side work (config lookup,
// provider call when keys are present, mapping) but skips Supabase writes and
// BullMQ enqueues. This is what keeps the scaffold safe before any live keys.

import {
  createTheirStackClient,
  createEnrichmentClient,
  mapJobToCompany,
  mapJobToRole,
  applyRevenueToMetadata,
  metadataHasRevenue,
  fetchWikipediaRevenue,
  TheirStackNotConfiguredError,
  EnrichmentNotConfiguredError,
  EnrichmentTargetUrlError,
  type TheirStackJob,
  type TheirStackSearchInput,
  type CompanyEnrichmentResult,
  type PocEnrichmentResult,
  type WikipediaLookupResult,
} from "@/lib/feeds/providers";
import {
  feedEnrichCompanyQueue,
  feedEnrichPocQueue,
  feedIngestSignalQueue,
  feedImportJobsQueue,
  ghostCheckQueue,
  type FeedIngestSignalPayload,
} from "@/lib/queues";

export type DryRunFlag = { dryRun: boolean };

type SupabaseLike = {
  from: (table: string) => {
    upsert: (
      values: Record<string, unknown>,
      options?: { onConflict?: string }
    ) => {
      select: (columns: string) => {
        single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
      };
    };
    update: (values: Record<string, unknown>) => {
      eq: (column: string, value: string) => Promise<{ error: { message: string } | null }>;
    };
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        single: () => Promise<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      };
    };
    insert: (values: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
  };
};

export type ImportJobsReport = {
  provider: "theirstack";
  dryRun: boolean;
  configured: boolean;
  missing?: string[];
  fetched: number;
  mapped: Array<{
    external_id: string;
    company: ReturnType<typeof mapJobToCompany>;
    role: ReturnType<typeof mapJobToRole>;
  }>;
  written: number;
  enqueued: { companyEnrich: number; ghostCheck: number };
  errors: string[];
};

export async function runTheirStackImport(
  input: TheirStackSearchInput & DryRunFlag,
  supabase: SupabaseLike | null
): Promise<ImportJobsReport> {
  const client = createTheirStackClient();
  if (!client.config.configured) {
    return {
      provider: "theirstack",
      dryRun: input.dryRun,
      configured: false,
      missing: client.config.missing,
      fetched: 0,
      mapped: [],
      written: 0,
      enqueued: { companyEnrich: 0, ghostCheck: 0 },
      errors: [],
    };
  }

  let jobs: TheirStackJob[] = [];
  const errors: string[] = [];
  try {
    const res = await client.searchJobs(input);
    jobs = res.jobs;
  } catch (err) {
    if (err instanceof TheirStackNotConfiguredError) {
      return {
        provider: "theirstack",
        dryRun: input.dryRun,
        configured: false,
        missing: err.missing,
        fetched: 0,
        mapped: [],
        written: 0,
        enqueued: { companyEnrich: 0, ghostCheck: 0 },
        errors: [err.message],
      };
    }
    errors.push(err instanceof Error ? err.message : String(err));
  }

  const mapped = jobs.map((job) => ({
    external_id: job.external_id,
    company: mapJobToCompany(job),
    role: mapJobToRole(job),
  }));

  if (input.dryRun || !supabase) {
    return {
      provider: "theirstack",
      dryRun: true,
      configured: true,
      fetched: jobs.length,
      mapped,
      written: 0,
      enqueued: { companyEnrich: 0, ghostCheck: 0 },
      errors,
    };
  }

  let written = 0;
  let companyEnrichEnqueued = 0;
  let ghostCheckEnqueued = 0;
  const companyQ = feedEnrichCompanyQueue();
  const ghostQ = ghostCheckQueue();

  for (const item of mapped) {
    const { data: company, error: companyErr } = await supabase
      .from("companies")
      .upsert(item.company, { onConflict: "domain" })
      .select("id")
      .single();
    if (companyErr || !company) {
      errors.push(`company upsert failed: ${companyErr?.message ?? "missing"}`);
      continue;
    }
    const { data: role, error: roleErr } = await supabase
      .from("roles")
      .upsert(
        { ...item.role, company_id: company.id },
        { onConflict: "company_id,external_id" }
      )
      .select("id")
      .single();
    if (roleErr || !role) {
      errors.push(`role upsert failed: ${roleErr?.message ?? "missing"}`);
      continue;
    }
    written += 1;
    if (companyQ) {
      await companyQ.add("enrich", { companyId: company.id });
      companyEnrichEnqueued += 1;
    }
    if (ghostQ) {
      await ghostQ.add("check", { roleId: role.id });
      ghostCheckEnqueued += 1;
    }
  }

  return {
    provider: "theirstack",
    dryRun: false,
    configured: true,
    fetched: jobs.length,
    mapped,
    written,
    enqueued: { companyEnrich: companyEnrichEnqueued, ghostCheck: ghostCheckEnqueued },
    errors,
  };
}

export type CompanyEnrichmentReport = {
  provider: "enrichment";
  dryRun: boolean;
  configured: boolean;
  missing?: string[];
  companyId: string;
  targetUrl?: string;
  targetUrlSource?: "request" | "base_url_fallback";
  result?: CompanyEnrichmentResult;
  metadataPatched?: Record<string, unknown>;
  wikipediaFallback?: WikipediaLookupResult;
  written: boolean;
  errors: string[];
};

export type EnrichmentRunOptions = DryRunFlag & { targetUrl?: string };

export async function runCompanyEnrichment(
  companyId: string,
  options: EnrichmentRunOptions,
  supabase: SupabaseLike | null
): Promise<CompanyEnrichmentReport> {
  const client = createEnrichmentClient();
  const errors: string[] = [];
  const primaryConfigured = client.config.configured;

  if (!supabase) {
    return {
      provider: "enrichment",
      dryRun: true,
      configured: primaryConfigured,
      companyId,
      written: false,
      errors: ["supabase client unavailable; treating as dry-run"],
    };
  }

  const { data: company, error: readErr } = await supabase
    .from("companies")
    .select("id, name, domain, metadata")
    .eq("id", companyId)
    .single();
  if (readErr || !company) {
    errors.push(`company ${companyId} not found`);
    return {
      provider: "enrichment",
      dryRun: options.dryRun,
      configured: primaryConfigured,
      companyId,
      written: false,
      errors,
    };
  }

  const targetUrlSource: "request" | "base_url_fallback" = options.targetUrl
    ? "request"
    : "base_url_fallback";

  let result: CompanyEnrichmentResult | undefined;
  if (primaryConfigured) {
    try {
      result = await client.enrichCompany({
        domain: typeof company.domain === "string" ? company.domain : undefined,
        name: String(company.name),
        targetUrl: options.targetUrl,
      });
    } catch (err) {
      if (err instanceof EnrichmentNotConfiguredError) {
        // Fall through to the Wikipedia fallback rather than aborting.
        errors.push(err.message);
      } else if (err instanceof EnrichmentTargetUrlError) {
        errors.push(`enrichment_target_url_required: ${err.message}`);
      } else {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  let metadataPatched = applyRevenueToMetadata(
    (company.metadata as Record<string, unknown> | null) ?? null,
    result?.revenue
  );
  if (result?.raw) {
    metadataPatched.enrichment = {
      ...(typeof metadataPatched.enrichment === "object" && metadataPatched.enrichment
        ? (metadataPatched.enrichment as Record<string, unknown>)
        : {}),
      ...result.raw,
      enrichedAt: new Date().toISOString(),
    };
  }

  // Wikipedia fallback: only fire when the company's *patched* metadata still
  // has no revenue and we have a usable company name. Failures here are
  // non-fatal — they're recorded in `wikipediaFallback` for observability but
  // never block the enrichment write.
  let wikipediaFallback: WikipediaLookupResult | undefined;
  const companyName = typeof company.name === "string" ? company.name : "";
  if (!metadataHasRevenue(metadataPatched) && companyName.trim().length > 0) {
    try {
      wikipediaFallback = await fetchWikipediaRevenue({
        name: companyName,
        domain: typeof company.domain === "string" ? company.domain : undefined,
      });
      if (wikipediaFallback.status === "ok") {
        metadataPatched = applyRevenueToMetadata(metadataPatched, {
          annualRevenue: wikipediaFallback.annualRevenue,
          currency: wikipediaFallback.currency,
          confidence: "low",
          source: wikipediaFallback.source,
        });
        metadataPatched.revenue_source = wikipediaFallback.source;
        metadataPatched.revenue_source_url = wikipediaFallback.sourceUrl;
        metadataPatched.revenue_source_label = wikipediaFallback.sourceLabel;
        metadataPatched.revenue_raw = wikipediaFallback.raw;
      }
    } catch (err) {
      // Defensive: fetchWikipediaRevenue is designed not to throw, but if a
      // host environment surfaces something unexpected we still keep imports
      // working.
      errors.push(
        `wikipedia_fallback_failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (options.dryRun) {
    return {
      provider: "enrichment",
      dryRun: true,
      configured: primaryConfigured,
      companyId,
      targetUrl: options.targetUrl,
      targetUrlSource,
      result,
      metadataPatched,
      wikipediaFallback,
      written: false,
      errors,
    };
  }

  const update: Record<string, unknown> = {
    metadata: metadataPatched,
    updated_at: new Date().toISOString(),
  };
  if (result?.industry) update.industry = result.industry;
  if (result?.size) update.size = result.size;
  const { error: updErr } = await supabase
    .from("companies")
    .update(update)
    .eq("id", companyId);
  if (updErr) errors.push(`company update failed: ${updErr.message}`);

  return {
    provider: "enrichment",
    dryRun: false,
    configured: primaryConfigured,
    companyId,
    targetUrl: options.targetUrl,
    targetUrlSource,
    result,
    metadataPatched,
    wikipediaFallback,
    written: !updErr,
    errors,
  };
}

export type PocEnrichmentReport = {
  provider: "enrichment";
  dryRun: boolean;
  configured: boolean;
  missing?: string[];
  companyId: string;
  targetUrl?: string;
  targetUrlSource?: "request" | "base_url_fallback";
  result?: PocEnrichmentResult;
  errors: string[];
};

export async function runPocEnrichment(
  input: { companyId: string; roleId?: string; targetUrl?: string } & DryRunFlag,
  supabase: SupabaseLike | null
): Promise<PocEnrichmentReport> {
  const client = createEnrichmentClient();
  if (!client.config.configured) {
    return {
      provider: "enrichment",
      dryRun: input.dryRun,
      configured: false,
      missing: client.config.missing,
      companyId: input.companyId,
      errors: [],
    };
  }
  if (!supabase) {
    return {
      provider: "enrichment",
      dryRun: true,
      configured: true,
      companyId: input.companyId,
      errors: ["supabase client unavailable; treating as dry-run"],
    };
  }
  const { data: company, error: readErr } = await supabase
    .from("companies")
    .select("id, name, domain")
    .eq("id", input.companyId)
    .single();
  if (readErr || !company) {
    return {
      provider: "enrichment",
      dryRun: input.dryRun,
      configured: true,
      companyId: input.companyId,
      errors: [`company ${input.companyId} not found`],
    };
  }
  const targetUrlSource: "request" | "base_url_fallback" = input.targetUrl
    ? "request"
    : "base_url_fallback";
  try {
    const result = await client.enrichPoc({
      companyDomain: typeof company.domain === "string" ? company.domain : undefined,
      companyName: String(company.name),
      targetUrl: input.targetUrl,
    });
    return {
      provider: "enrichment",
      dryRun: input.dryRun,
      configured: true,
      companyId: input.companyId,
      targetUrl: input.targetUrl,
      targetUrlSource,
      result,
      errors: [],
    };
  } catch (err) {
    if (err instanceof EnrichmentNotConfiguredError) {
      return {
        provider: "enrichment",
        dryRun: input.dryRun,
        configured: false,
        missing: err.missing,
        companyId: input.companyId,
        errors: [err.message],
      };
    }
    if (err instanceof EnrichmentTargetUrlError) {
      return {
        provider: "enrichment",
        dryRun: input.dryRun,
        configured: true,
        companyId: input.companyId,
        errors: [`enrichment_target_url_required: ${err.message}`],
      };
    }
    return {
      provider: "enrichment",
      dryRun: input.dryRun,
      configured: true,
      companyId: input.companyId,
      targetUrl: input.targetUrl,
      targetUrlSource,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}

export type SignalIngestReport = {
  dryRun: boolean;
  written: boolean;
  enqueued: boolean;
  errors: string[];
};

export async function runSignalIngest(
  payload: FeedIngestSignalPayload,
  options: DryRunFlag,
  supabase: SupabaseLike | null
): Promise<SignalIngestReport> {
  const errors: string[] = [];
  if (options.dryRun || !supabase) {
    const q = feedIngestSignalQueue();
    return { dryRun: true, written: false, enqueued: !!q, errors };
  }
  const { error } = await supabase.from("signals").insert({
    kind: payload.kind,
    title: payload.title,
    detail: payload.detail ?? null,
    href: payload.href ?? null,
    company_id: payload.companyId ?? null,
    role_id: payload.roleId ?? null,
    metadata: payload.metadata ?? {},
  });
  if (error) errors.push(error.message);
  return { dryRun: false, written: !error, enqueued: false, errors };
}

// Helper used by the API route to push the import work onto BullMQ rather than
// running it inline. Returns null if Redis isn't configured.
export async function enqueueImportJobs(
  payload: TheirStackSearchInput
): Promise<{ id: string } | null> {
  const q = feedImportJobsQueue();
  if (!q) return null;
  const job = await q.add("import", payload);
  return { id: String(job.id) };
}
