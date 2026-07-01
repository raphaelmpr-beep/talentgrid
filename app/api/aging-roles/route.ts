// GET /api/aging-roles
//
// Returns aging job openings (default: >90 days old) with optional multi-select
// job-function filter and compensation aggregation. Purely additive — reads from
// the existing `roles` and `companies` tables with no schema changes.
//
// Query params:
//   minDaysOpen   integer, default 90
//   functions     comma-separated JobFunctionValues (e.g. "software_engineering,ai_ml")
//   limit         integer, default 200, max 500
//   offset        integer, default 0
//   companyId     uuid (optional, single-company drill-down)

import { NextResponse, type NextRequest } from "next/server";
import { createClient, supabaseNotConfiguredResponse } from "@/lib/supabase/server";
import {
  roleCategoryToJobFunction,
  classifyJobFunction,
  JOB_FUNCTIONS,
  type JobFunctionValue,
} from "@/lib/feeds/job-function";
import { z } from "zod";

export const runtime = "nodejs";

// ── Query schema ─────────────────────────────────────────────────────────────

const querySchema = z.object({
  minDaysOpen: z.coerce.number().int().min(1).max(3650).default(90),
  functions: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : []
    ),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  companyId: z.string().uuid().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function annualise(
  value: number | null | undefined,
  period: string | null | undefined
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  switch ((period ?? "year").toLowerCase()) {
    case "hour":    return Math.round(value * 2080);
    case "month":   return Math.round(value * 12);
    case "week":    return Math.round(value * 52);
    case "year":
    default:        return Math.round(value);
  }
}

function daysOpen(
  postedAt: string | null | undefined,
  discoveredAt: string | null | undefined,
  lastSeenAt: string | null | undefined
): number | null {
  // Priority: posted_at → discovered_at → last_seen_at
  const raw = postedAt ?? discoveredAt ?? lastSeenAt;
  if (!raw) return null;
  const ms = Date.now() - new Date(raw).getTime();
  if (ms < 0) return null;
  return Math.floor(ms / 86_400_000);
}

// ── Types ─────────────────────────────────────────────────────────────────────

type RawRole = {
  id: string;
  title: string;
  location: string | null;
  url: string | null;
  is_active: boolean;
  ghost_score: number;
  posted_at: string | null;
  discovered_at: string | null;
  last_seen_at: string | null;
  role_category: string | null;
  compensation_min: number | null;
  compensation_max: number | null;
  compensation_currency: string | null;
  compensation_period: string | null;
  compensation_text: string | null;
  compensation_source: string | null;
  compensation_status: string | null;
  company_id: string;
  companies: {
    id: string;
    name: string;
    domain: string | null;
    industry: string | null;
  } | null;
};

export type AgingRole = {
  id: string;
  company_id: string;
  company_name: string;
  company_domain: string | null;
  title: string;
  job_function: JobFunctionValue | null;
  job_function_label: string | null;
  location: string | null;
  url: string | null;
  // Best available date field that was used to compute days_open
  date_field_used: "posted_at" | "discovered_at" | "last_seen_at" | null;
  date_value: string | null;
  days_open: number | null;
  // Compensation (annualised to yearly USD where period is known)
  comp_min_annual: number | null;
  comp_max_annual: number | null;
  comp_midpoint_annual: number | null;
  comp_currency: string | null;
  comp_period: string | null;
  comp_text: string | null;
  comp_source: string | null;
  comp_disclosed: boolean;
};

export type AgingRoleSummary = {
  total_aging_roles: number;
  roles_with_compensation: number;
  roles_missing_compensation: number;
  // Totals across all roles with compensation (annual USD)
  total_comp_min: number;
  total_comp_max: number;
  total_comp_midpoint: number;
  // Averages
  avg_comp_min: number | null;
  avg_comp_max: number | null;
  avg_comp_midpoint: number | null;
  // Top companies by aging-role count
  top_companies_by_count: Array<{
    company_id: string;
    company_name: string;
    aging_role_count: number;
    roles_with_comp: number;
  }>;
  // Top companies by total compensation value (midpoint sum)
  top_companies_by_comp: Array<{
    company_id: string;
    company_name: string;
    total_comp_midpoint: number;
    aging_role_count: number;
  }>;
};

// ── Route ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams)
  );
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { minDaysOpen, functions: requestedFunctions, limit, offset, companyId } = parsed.data;

  const supabase = await createClient();
  if (!supabase) return supabaseNotConfiguredResponse();

  // Cutoff date: roles must have been open since at least this date.
  const cutoff = new Date(Date.now() - minDaysOpen * 86_400_000).toISOString();

  // ── DB query ────────────────────────────────────────────────────────────────
  // We pull a bounded window of active roles with a posted_at or discovered_at
  // older than the cutoff. Using OR across all three date fields so we do not
  // miss roles where only one field is populated.
  //
  // Note: role_category is stored by the cron classifier. For roles without it
  // we re-classify at result-mapping time using the title.

  let query = supabase
    .from("roles")
    .select(
      `id, title, location, url, is_active, ghost_score,
       posted_at, discovered_at, last_seen_at, role_category,
       compensation_min, compensation_max, compensation_currency,
       compensation_period, compensation_text, compensation_source, compensation_status,
       company_id,
       companies!inner(id, name, domain, industry)`,
      { count: "exact" }
    )
    .eq("is_active", true)
    .lt("ghost_score", 40)
    // At least one date field must be old enough. PostgREST OR filter:
    .or(
      [
        posted_at_filter(cutoff),
        discovered_at_filter(cutoff),
      ].join(",")
    )
    .order("posted_at", { ascending: true, nullsFirst: false })
    .range(offset, offset + limit - 1);

  if (companyId) query = query.eq("company_id", companyId);

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rawRoles = (data ?? []) as unknown as RawRole[];

  // ── Map & filter by job function ────────────────────────────────────────────
  const validFunctionSet = new Set(JOB_FUNCTIONS.map((f) => f.value));
  const wantedFunctions = requestedFunctions.filter((f) =>
    validFunctionSet.has(f as JobFunctionValue)
  ) as JobFunctionValue[];

  const functionLabelMap = Object.fromEntries(
    JOB_FUNCTIONS.map((f) => [f.value, f.label])
  );

  const agingRoles: AgingRole[] = [];

  for (const r of rawRoles) {
    // Determine date field used and days open
    const dateFieldUsed: AgingRole["date_field_used"] = r.posted_at
      ? "posted_at"
      : r.discovered_at
      ? "discovered_at"
      : r.last_seen_at
      ? "last_seen_at"
      : null;
    const dateValue = r.posted_at ?? r.discovered_at ?? r.last_seen_at ?? null;
    const days = daysOpen(r.posted_at, r.discovered_at, r.last_seen_at);

    // Skip rows where no date is old enough (belt-and-suspenders — the DB
    // filter should already exclude these, but last_seen_at is not in the DB
    // OR filter and is used as a last resort only in the JS layer).
    if (days === null || days < minDaysOpen) continue;

    // Classify job function — prefer stored role_category, then title.
    const jf =
      roleCategoryToJobFunction(r.role_category, r.title) ??
      classifyJobFunction(r.title, r.role_category);

    // Apply function filter when specified.
    if (wantedFunctions.length > 0 && (jf === null || !wantedFunctions.includes(jf))) {
      continue;
    }

    // Annualise compensation.
    const compMin = annualise(r.compensation_min, r.compensation_period);
    const compMax = annualise(r.compensation_max, r.compensation_period);
    const compMid =
      compMin != null && compMax != null
        ? Math.round((compMin + compMax) / 2)
        : compMin ?? compMax ?? null;

    const compDisclosed =
      compMin != null || compMax != null || !!r.compensation_text;

    const company = r.companies;

    agingRoles.push({
      id: r.id,
      company_id: r.company_id,
      company_name: company?.name ?? "Unknown",
      company_domain: company?.domain ?? null,
      title: r.title,
      job_function: jf,
      job_function_label: jf ? (functionLabelMap[jf] ?? null) : null,
      location: r.location,
      url: r.url,
      date_field_used: dateFieldUsed,
      date_value: dateValue,
      days_open: days,
      comp_min_annual: compMin,
      comp_max_annual: compMax,
      comp_midpoint_annual: compMid,
      comp_currency: r.compensation_currency,
      comp_period: r.compensation_period,
      comp_text: r.compensation_text,
      comp_source: r.compensation_source,
      comp_disclosed: compDisclosed,
    });
  }

  // ── Aggregation ─────────────────────────────────────────────────────────────
  const withComp = agingRoles.filter((r) => r.comp_disclosed);
  const withMid  = agingRoles.filter((r) => r.comp_midpoint_annual != null);
  const withMin  = agingRoles.filter((r) => r.comp_min_annual != null);
  const withMax  = agingRoles.filter((r) => r.comp_max_annual != null);

  const sum = (arr: AgingRole[], key: keyof AgingRole): number =>
    arr.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);

  const totalMin = sum(withMin, "comp_min_annual");
  const totalMax = sum(withMax, "comp_max_annual");
  const totalMid = sum(withMid, "comp_midpoint_annual");

  // Per-company aggregation.
  const byCompany = new Map<
    string,
    { name: string; count: number; compCount: number; midSum: number }
  >();
  for (const r of agingRoles) {
    const existing = byCompany.get(r.company_id) ?? {
      name: r.company_name,
      count: 0,
      compCount: 0,
      midSum: 0,
    };
    existing.count += 1;
    if (r.comp_disclosed) existing.compCount += 1;
    if (r.comp_midpoint_annual != null) existing.midSum += r.comp_midpoint_annual;
    byCompany.set(r.company_id, existing);
  }

  const companyEntries = Array.from(byCompany.entries()).map(([id, v]) => ({
    company_id: id,
    company_name: v.name,
    aging_role_count: v.count,
    roles_with_comp: v.compCount,
    total_comp_midpoint: v.midSum,
  }));

  const topByCount = [...companyEntries]
    .sort((a, b) => b.aging_role_count - a.aging_role_count)
    .slice(0, 10);

  const topByComp = [...companyEntries]
    .filter((c) => c.total_comp_midpoint > 0)
    .sort((a, b) => b.total_comp_midpoint - a.total_comp_midpoint)
    .slice(0, 10);

  const summary: AgingRoleSummary = {
    total_aging_roles: agingRoles.length,
    roles_with_compensation: withComp.length,
    roles_missing_compensation: agingRoles.length - withComp.length,
    total_comp_min: totalMin,
    total_comp_max: totalMax,
    total_comp_midpoint: totalMid,
    avg_comp_min: withMin.length > 0 ? Math.round(totalMin / withMin.length) : null,
    avg_comp_max: withMax.length > 0 ? Math.round(totalMax / withMax.length) : null,
    avg_comp_midpoint: withMid.length > 0 ? Math.round(totalMid / withMid.length) : null,
    top_companies_by_count: topByCount,
    top_companies_by_comp: topByComp,
  };

  return NextResponse.json({
    query: {
      min_days_open: minDaysOpen,
      functions: wantedFunctions,
      limit,
      offset,
      cutoff_date: cutoff,
    },
    summary,
    roles: agingRoles,
    total_matched_db: count ?? 0,
    total_after_function_filter: agingRoles.length,
  });
}

// ── PostgREST filter helpers ──────────────────────────────────────────────────

function posted_at_filter(cutoff: string): string {
  // posted_at < cutoff (role was posted before the cutoff → it has been open
  // at least minDaysOpen days).
  return `posted_at.lt.${cutoff}`;
}

function discovered_at_filter(cutoff: string): string {
  return `discovered_at.lt.${cutoff}`;
}
