"use client";

import * as React from "react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { formatCompactNumber, formatRelative } from "@/lib/utils";

type EmbeddedRole = {
  id: string;
  title: string;
  location?: string | null;
  remote?: boolean | null;
  employment_type?: string | null;
  seniority?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  url?: string | null;
  ghost_score?: number | null;
  posted_at?: string | null;
  role_family?: string | null;
};

type Company = {
  id: string;
  name: string;
  domain?: string | null;
  description?: string | null;
  industry?: string | null;
  size?: string | null;
  location?: string | null;
  logo_url?: string | null;
  is_hiring: boolean;
  metadata?: Record<string, unknown> | null;
  open_roles_count?: number;
  role_families?: Record<string, number>;
  roles?: EmbeddedRole[];
  created_at: string;
};

type Page<T> = { data: T[]; page: number; pageSize: number; total: number };

const ROLE_FAMILIES = [
  { value: "all", label: "All" },
  { value: "engineer", label: "Software Engineer" },
  { value: "frontend", label: "Frontend" },
  { value: "backend", label: "Backend" },
  { value: "fullstack", label: "Full Stack" },
  { value: "devops", label: "DevOps / SRE" },
  { value: "data", label: "Data" },
  { value: "mobile", label: "Mobile" },
  { value: "ml", label: "ML / AI" },
];

type SortKey = "hiring_desc" | "hiring_asc" | "name_asc" | "newest";

const DEFAULT_MIN_REVENUE = 0;
const DEFAULT_MAX_REVENUE = 10_000_000_000;
const DEFAULT_PAGE_SIZE = 20;
const ROLES_PREVIEW_LIMIT = 10;

function hiringVolume(c: Company, family: string): number {
  if (family !== "all") {
    const familyCount = c.role_families?.[family];
    if (typeof familyCount === "number") return familyCount;
    return (c.roles ?? []).filter((r) => r.role_family === family).length;
  }

  if (typeof c.open_roles_count === "number") return c.open_roles_count;
  const m = (c.metadata ?? {}) as Record<string, unknown>;
  const direct = m["open_roles_count"] ?? m["hiring_volume"] ?? m["open_roles"];
  return typeof direct === "number" ? direct : 0;
}

function ghostBadge(score: number | null | undefined): React.ReactNode {
  const s = score ?? 0;
  if (s < 20) return <Badge variant="success">Fresh</Badge>;
  if (s < 40) return <Badge variant="secondary">Active</Badge>;
  if (s < 70) return <Badge variant="warning">Stale</Badge>;
  return <Badge variant="danger">Ghost</Badge>;
}

function salaryLabel(role: EmbeddedRole): string | null {
  if (!role.salary_min && !role.salary_max) return null;
  const fmt = (n: number) =>
    new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
  if (role.salary_min && role.salary_max)
    return `$${fmt(role.salary_min)}–${fmt(role.salary_max)}`;
  if (role.salary_min) return `$${fmt(role.salary_min)}+`;
  return `up to $${fmt(role.salary_max!)}`;
}

function InlineRoleList({
  roles,
  companyId,
  totalRoles,
}: {
  roles: EmbeddedRole[];
  companyId: string;
  totalRoles: number;
}) {
  const preview = roles.slice(0, ROLES_PREVIEW_LIMIT);
  const hasMore = totalRoles > ROLES_PREVIEW_LIMIT;

  if (roles.length === 0) {
    return (
      <p className="py-3 text-xs text-neutral-400 italic">
        No matching roles for this filter.
      </p>
    );
  }

  return (
    <div>
      <table className="w-full text-sm">
        <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-400">
          <tr>
            <th className="px-3 py-1.5 text-left font-medium">Role</th>
            <th className="hidden px-3 py-1.5 text-left font-medium sm:table-cell">
              Location
            </th>
            <th className="hidden px-3 py-1.5 text-left font-medium md:table-cell">
              Compensation
            </th>
            <th className="px-3 py-1.5 text-left font-medium">Status</th>
            <th className="hidden px-3 py-1.5 text-left font-medium sm:table-cell">
              Posted
            </th>
            <th className="px-3 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {preview.map((role) => (
            <tr
              key={role.id}
              className="border-t border-neutral-100 hover:bg-neutral-50"
            >
              <td className="px-3 py-2 align-top">
                <div className="font-medium text-neutral-900">{role.title}</div>
                <div className="mt-0.5 flex flex-wrap gap-1 text-xs text-neutral-500">
                  {role.seniority && <span>{role.seniority}</span>}
                  {role.employment_type && (
                    <>
                      <span>·</span>
                      <span>{role.employment_type}</span>
                    </>
                  )}
                </div>
              </td>
              <td className="hidden px-3 py-2 align-top text-neutral-700 sm:table-cell">
                {role.location ?? (role.remote ? "Remote" : "—")}
                {role.remote && role.location && (
                  <span className="ml-1 text-xs text-neutral-400">(remote ok)</span>
                )}
              </td>
              <td className="hidden px-3 py-2 align-top text-neutral-700 md:table-cell">
                {salaryLabel(role) ?? "—"}
              </td>
              <td className="px-3 py-2 align-top">{ghostBadge(role.ghost_score)}</td>
              <td className="hidden px-3 py-2 align-top text-neutral-500 sm:table-cell">
                {formatRelative(role.posted_at) || "—"}
              </td>
              <td className="px-3 py-2 align-top">
                {role.url ? (
                  <a
                    href={role.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-blue-600 hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Apply ↗
                  </a>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {hasMore && (
        <div className="border-t border-neutral-100 px-3 py-2">
          <Link
            href={`/companies/${companyId}`}
            className="text-xs text-blue-600 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            View all {totalRoles} roles →
          </Link>
        </div>
      )}
    </div>
  );
}

export default function CompaniesPage() {
  const [items, setItems] = React.useState<Company[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [debouncedQ, setDebouncedQ] = React.useState("");
  const [hiringOnly, setHiringOnly] = React.useState(true);
  const [family, setFamily] = React.useState("all");
  const [pageSize, setPageSize] = React.useState<number>(DEFAULT_PAGE_SIZE);
  const [sort, setSort] = React.useState<SortKey>("hiring_desc");
  const [minRevenue, setMinRevenue] = React.useState<number>(DEFAULT_MIN_REVENUE);
  const [maxRevenue, setMaxRevenue] = React.useState<number>(DEFAULT_MAX_REVENUE);
  const [includeUnknownRevenue, setIncludeUnknownRevenue] = React.useState(true);
  const [minRevenueInput, setMinRevenueInput] = React.useState<string>(
    String(DEFAULT_MIN_REVENUE)
  );
  const [maxRevenueInput, setMaxRevenueInput] = React.useState<string>(
    String(DEFAULT_MAX_REVENUE)
  );
  const [page, setPage] = React.useState(1);
  const [total, setTotal] = React.useState(0);
  const [hasMore, setHasMore] = React.useState(false);
  const loadMoreRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  React.useEffect(() => {
    setItems([]);
    setTotal(0);
    setHasMore(false);
    setPage(1);
  }, [debouncedQ, hiringOnly, family, pageSize, minRevenue, maxRevenue, includeUnknownRevenue]);

  React.useEffect(() => {
    let cancelled = false;

    if (page === 1) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    setError(null);

    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    if (debouncedQ) params.set("q", debouncedQ);
    if (!hiringOnly) params.set("isHiring", "false");
    if (family !== "all") params.set("family", family);
    params.set("minRevenue", String(minRevenue));
    params.set("maxRevenue", String(maxRevenue));
    if (includeUnknownRevenue) params.set("includeUnknownRevenue", "true");

    fetch(`/api/companies?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`Failed: ${r.status}`);
        return (await r.json()) as Page<Company>;
      })
      .then((nextPage) => {
        if (cancelled) return;

        const nextItems = nextPage.data ?? [];
        setTotal(nextPage.total ?? 0);
        setHasMore(page * pageSize < (nextPage.total ?? 0));

        setItems((prev) => {
          if (page === 1) return nextItems;
          const seen = new Set(prev.map((c) => c.id));
          const appended = nextItems.filter((c) => !seen.has(c.id));
          return [...prev, ...appended];
        });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setLoadingMore(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [page, pageSize, debouncedQ, hiringOnly, family, minRevenue, maxRevenue, includeUnknownRevenue]);

  React.useEffect(() => {
    if (!hasMore || loading || loadingMore || error) return;
    const el = loadMoreRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting) return;
        observer.unobserve(entry.target);
        setPage((p) => p + 1);
      },
      { rootMargin: "300px 0px" }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, error, items.length]);

  const filteredSorted = React.useMemo(() => {
    const sorted = [...items];
    sorted.sort((a, b) => {
      switch (sort) {
        case "hiring_desc":
          return hiringVolume(b, family) - hiringVolume(a, family);
        case "hiring_asc":
          return hiringVolume(a, family) - hiringVolume(b, family);
        case "name_asc":
          return a.name.localeCompare(b.name);
        case "newest":
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
    });

    return sorted;
  }, [items, sort, family]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Companies</h1>
          <p className="text-sm text-neutral-500">
            Browse companies actively hiring. Filter by role family or search by name.
          </p>
        </div>
      </header>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search companies…"
            className="max-w-xs"
            aria-label="Search companies"
          />

          <label className="inline-flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              checked={hiringOnly}
              onChange={(e) => setHiringOnly(e.target.checked)}
              className="h-4 w-4 rounded border-neutral-300"
            />
            Hiring only
          </label>

          <ToggleGroup value={family} onChange={setFamily} options={ROLE_FAMILIES} />

          <div className="flex items-center gap-2">
            <label htmlFor="minRevenue" className="text-xs uppercase tracking-wide text-neutral-500">
              Revenue $
            </label>
            <Input
              id="minRevenue"
              type="number"
              inputMode="numeric"
              min={0}
              step={10_000_000}
              value={minRevenueInput}
              onChange={(e) => setMinRevenueInput(e.target.value)}
              onBlur={() => {
                const n = Number(minRevenueInput);
                setMinRevenue(Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_REVENUE);
              }}
              className="w-32"
              aria-label="Minimum annual revenue"
            />
            <span className="text-neutral-400">-</span>
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              step={10_000_000}
              value={maxRevenueInput}
              onChange={(e) => setMaxRevenueInput(e.target.value)}
              onBlur={() => {
                const n = Number(maxRevenueInput);
                setMaxRevenue(Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_REVENUE);
              }}
              className="w-40"
              aria-label="Maximum annual revenue"
            />
            <label className="inline-flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                checked={includeUnknownRevenue}
                onChange={(e) => setIncludeUnknownRevenue(e.target.checked)}
                className="h-4 w-4 rounded border-neutral-300"
              />
              Include unknown revenue
            </label>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <label
              htmlFor="pageSize"
              className="text-xs uppercase tracking-wide text-neutral-500"
            >
              Page size
            </label>
            <Select
              id="pageSize"
              value={String(pageSize)}
              onChange={(e) => setPageSize(Number(e.target.value) || DEFAULT_PAGE_SIZE)}
            >
              <option value="20">20</option>
              <option value="50">50</option>
            </Select>

            <label htmlFor="sort" className="text-xs uppercase tracking-wide text-neutral-500">
              Sort
            </label>
            <Select id="sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="hiring_desc">Hiring volume ↓</option>
              <option value="hiring_asc">Hiring volume ↑</option>
              <option value="name_asc">Name A-Z</option>
              <option value="newest">Newest</option>
            </Select>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-48 w-full" />
          ))}
        </div>
      ) : filteredSorted.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-500">
          No companies match your filters.
        </div>
      ) : (
        <>
          <div className="space-y-4">
            {filteredSorted.map((c) => {
              const allRoles = c.roles ?? [];
              const visibleRoles =
                family === "all"
                  ? allRoles
                  : allRoles.filter((r) => r.role_family === family);
              const volume = hiringVolume(c, family);

              return (
                <Card key={c.id} className="overflow-hidden">
                  <CardContent className="p-0">
                    {/* Company header */}
                    <div className="flex flex-wrap items-start gap-4 p-4">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-neutral-100 text-base font-semibold text-neutral-600">
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
                          <Link
                            href={`/companies/${c.id}`}
                            className="text-base font-semibold hover:underline"
                          >
                            {c.name}
                          </Link>
                          {c.is_hiring && <Badge variant="success">Hiring</Badge>}
                        </div>
                        <p className="text-xs text-neutral-500">
                          {[c.industry, c.size, c.location]
                            .filter(Boolean)
                            .join(" · ") || c.domain || ""}
                        </p>
                        {c.description && (
                          <p className="mt-1 line-clamp-2 text-sm text-neutral-600">
                            {c.description}
                          </p>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-xl font-semibold tabular-nums">
                          {formatCompactNumber(volume)}
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-neutral-500">
                          open roles
                        </div>
                      </div>
                    </div>

                    {/* Inline job listings */}
                    <div className="border-t border-neutral-100">
                      <InlineRoleList
                        roles={visibleRoles}
                        companyId={c.id}
                        totalRoles={volume}
                      />
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <div className="flex items-center justify-between text-xs text-neutral-500">
            <span>
              Showing {items.length} of {total}
            </span>
            {hasMore && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading..." : "Load more"}
              </Button>
            )}
          </div>

          {hasMore && <div ref={loadMoreRef} className="h-6" aria-hidden="true" />}
        </>
      )}
    </div>
  );
}
