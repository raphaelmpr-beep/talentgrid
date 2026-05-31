import { NextResponse, type NextRequest } from "next/server";
import { createClient, supabaseNotConfiguredResponse } from "@/lib/supabase/server";
import { companyQuerySchema } from "@/lib/validators/company";
import {
  classifyRoleCategory,
  classifyDomainCategory,
} from "@/lib/feeds/classify";

export const runtime = "nodejs";

// Active-role criteria, kept identical to the company-card endpoint
// (app/api/companies/route.ts fetchAllActiveRoles): is_active = true and
// ghost_score < 70. This is what makes the per-company jobs count line up with
// the card's active_openings_matching_filters when the same filters are passed.
const GHOST_SCORE_CUTOFF = 70;

type RoleRow = {
  id: string;
  company_id: string;
  external_id?: string | null;
  source?: string | null;
  title?: string | null;
  description?: string | null;
  location?: string | null;
  remote?: boolean | null;
  employment_type?: string | null;
  seniority?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  url?: string | null;
  ghost_score?: number | null;
  posted_at?: string | null;
  created_at?: string | null;
  role_category?: string | null;
  domain_category?: string | null;
  metadata?: Record<string, unknown> | null;
};

function asLowerText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function getQueryTokens(query: string): string[] {
  return query
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 2);
}

// Resolve a role's role-family bucket: prefer the persisted role_category the
// cron classified, else classify on the fly from title/description so legacy
// rows without role_category still match the same way the card endpoint does.
function resolveRoleCategory(role: RoleRow): string | null {
  const stored = asLowerText(role.role_category);
  if (stored) return stored;
  return classifyRoleCategory(role.title ?? null, role.description ?? null);
}

function resolveDomainCategory(role: RoleRow): string | null {
  const stored = asLowerText(role.domain_category);
  if (stored) return stored;
  return classifyDomainCategory(role.title ?? null, role.description ?? null);
}

// Mirror the card endpoint's per-job matching: a role passes when it matches the
// active role filter (by role_category or title), the active domain filter (by
// domain_category), and the free-text query (title/description tokens).
function roleMatches(
  role: RoleRow,
  filters: { role?: string; domain?: string; query: string }
): boolean {
  const title = asLowerText(role.title);
  const description = asLowerText(role.description);
  const haystack = `${title} ${description}`;

  const roleFilter = filters.role;
  const roleMatch = !roleFilter
    ? true
    : resolveRoleCategory(role) === roleFilter || title.includes(roleFilter);

  const domainFilter = filters.domain;
  const domainMatch = !domainFilter
    ? true
    : resolveDomainCategory(role) === domainFilter;

  const query = filters.query;
  const tokens = getQueryTokens(query);
  const queryMatch = !query
    ? true
    : tokens.length > 0
      ? tokens.some((token) => haystack.includes(token))
      : haystack.includes(query);

  return roleMatch && domainMatch && queryMatch;
}

// GET /api/companies/[id]/jobs — the active jobs for one company, narrowed by the
// SAME role/domain/search filters the company-card endpoint accepts. When the
// same filters are passed, the returned matching_count equals the card's
// active_openings_matching_filters, so a "View Jobs" drill-down shows exactly the
// roles the card counted. Revenue filters are company-level and do not apply here.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const parsed = companyQuerySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams)
  );
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { role, family, roleFamily, roleCategory, domain, q } = parsed.data;
  // Accept all four role-family param spellings, identical to the card endpoint.
  const effectiveRole = role ?? family ?? roleFamily ?? roleCategory;
  const effectiveDomain = domain;
  const freeText = asLowerText(q);

  const supabase = await createClient();
  if (!supabase) return supabaseNotConfiguredResponse();

  const { data, error } = await supabase
    .from("roles")
    .select(
      "id,company_id,external_id,source,title,description,location,remote,employment_type,seniority,salary_min,salary_max,url,ghost_score,posted_at,created_at,role_category,domain_category,metadata"
    )
    .eq("company_id", id)
    .eq("is_active", true)
    .lt("ghost_score", GHOST_SCORE_CUTOFF)
    .order("posted_at", { ascending: false, nullsFirst: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const allActive = (data ?? []) as RoleRow[];

  // Dedupe by canonical job identity so a stale legacy row and a freshly
  // refreshed row for the same opening count once, matching the card endpoint.
  const seen = new Set<string>();
  const deduped: RoleRow[] = [];
  for (const role of allActive) {
    const meta = role.metadata ?? {};
    const key =
      asLowerText(meta["external_id"]) ||
      asLowerText(meta["source_id"]) ||
      asLowerText(meta["gh_jid"]) ||
      asLowerText(role.external_id) ||
      asLowerText(role.url) ||
      `title:${asLowerText(role.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(role);
  }

  const filters = {
    role: effectiveRole,
    domain: effectiveDomain,
    query: freeText,
  };
  const matching = deduped.filter((role) => roleMatches(role, filters));

  const hasFilters = Boolean(effectiveRole || effectiveDomain || freeText);

  return NextResponse.json({
    company_id: id,
    // total_active_count is every active opening; matching_count is the subset
    // after the same role/domain/search filters the card applied. The card's
    // active_openings_matching_filters equals matching_count for the same query.
    total_active_count: deduped.length,
    matching_count: matching.length,
    count_is_filtered: hasFilters && matching.length !== deduped.length,
    filters_applied: {
      role: effectiveRole ?? null,
      domain: effectiveDomain ?? null,
      q: q ?? null,
    },
    jobs: matching.map((role) => ({
      id: role.id,
      title: role.title,
      location: role.location,
      remote: role.remote,
      employment_type: role.employment_type,
      seniority: role.seniority,
      salary_min: role.salary_min,
      salary_max: role.salary_max,
      url: role.url,
      ghost_score: role.ghost_score,
      posted_at: role.posted_at,
      role_category: resolveRoleCategory(role),
      domain_category: resolveDomainCategory(role),
    })),
  });
}
