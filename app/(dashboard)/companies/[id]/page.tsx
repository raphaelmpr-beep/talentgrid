import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { CompanyDetailTabs } from "./tabs";
import { CompanyFavoriteButton } from "./favorite-button";

type Params = { id: string };

type CompanyRow = {
  id: string;
  name: string;
  domain?: string | null;
  description?: string | null;
  industry?: string | null;
  size?: string | null;
  location?: string | null;
  logo_url?: string | null;
  website?: string | null;
  is_hiring: boolean;
  metadata?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type RoleRow = {
  id: string;
  company_id: string;
  title: string;
  description?: string | null;
  location?: string | null;
  remote?: boolean;
  employment_type?: string | null;
  seniority?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  compensation_min?: number | string | null;
  compensation_max?: number | string | null;
  compensation_currency?: string | null;
  compensation_period?: string | null;
  compensation_text?: string | null;
  compensation_source?: string | null;
  compensation_status?: string | null;
  url?: string | null;
  is_active: boolean;
  ghost_score: number;
  posted_at?: string | null;
  posted_status?: string | null;
  discovered_at?: string | null;
  last_seen_at?: string | null;
  role_category?: string | null;
  domain_category?: string | null;
  metadata?: Record<string, unknown> | null;
};

export default async function CompanyDetailPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  if (!supabase) {
    notFound();
  }

  const [{ data: company, error: companyError }, { data: roles }] =
    await Promise.all([
      supabase.from("companies").select("*").eq("id", id).maybeSingle(),
      supabase
        .from("roles")
        .select("*")
        .eq("company_id", id)
        .order("posted_at", { ascending: false, nullsFirst: false })
        .limit(100),
    ]);

  if (companyError || !company) {
    notFound();
  }

  const c = company as CompanyRow;
  const allRoles = (roles ?? []) as RoleRow[];
  const activeRoles = allRoles.filter((r) => r.is_active && r.ghost_score < 70);
  const ghostRoles = allRoles.filter((r) => r.ghost_score >= 70 || !r.is_active);

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="p-6">
          <div className="flex flex-wrap items-start gap-6">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-neutral-100 text-2xl font-semibold text-neutral-600">
              {c.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={c.logo_url}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                c.name.slice(0, 1).toUpperCase()
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">
                  {c.name}
                </h1>
                {c.is_hiring && <Badge variant="success">Hiring</Badge>}
              </div>
              <div className="mt-1 flex flex-wrap gap-2 text-sm text-neutral-500">
                {c.industry && <span>{c.industry}</span>}
                {c.size && (
                  <>
                    <span>·</span>
                    <span>{c.size}</span>
                  </>
                )}
                {c.location && (
                  <>
                    <span>·</span>
                    <span>{c.location}</span>
                  </>
                )}
                {c.website && (
                  <>
                    <span>·</span>
                    <a
                      href={c.website}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      Website ↗
                    </a>
                  </>
                )}
              </div>
              {c.description && (
                <p className="mt-3 max-w-3xl text-sm text-neutral-700">
                  {c.description}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <CompanyFavoriteButton companyId={c.id} />
            </div>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Open roles" value={activeRoles.length} />
            <Stat label="Ghost roles" value={ghostRoles.length} />
            <Stat
              label="Avg ghost score"
              value={
                allRoles.length
                  ? Math.round(
                      allRoles.reduce((a, r) => a + (r.ghost_score ?? 0), 0) /
                        allRoles.length
                    )
                  : 0
              }
            />
            <Stat
              label="Remote-ok"
              value={activeRoles.filter((r) => r.remote).length}
            />
          </div>
        </CardContent>
      </Card>

      <CompanyDetailTabs
        company={c}
        activeRoles={activeRoles}
        ghostRoles={ghostRoles}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
      <div className="text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
