"use client";

import * as React from "react";
import { Select } from "@/components/ui/select";
import { SearchBar } from "@/components/SearchBar";
import { DomainFilter } from "@/components/DomainFilter";
import { RoleFilter } from "@/components/RoleFilter";
import { RevenueFilter } from "@/components/RevenueFilter";
import { CompanyList } from "@/components/CompanyList";
import type { CompanyResult } from "@/components/company-results/types";

type PageResponse = {
  data: CompanyResult[];
  total: number;
  filters?: {
    domain?: string;
    role?: string;
    q?: string;
  };
};

type SortKey = "job_count_desc" | "job_count_asc" | "name_asc" | "newest";

const PAGE_SIZE = 50;

type SmartQuery = {
  detectedDomain?: string;
  detectedRole?: string;
};

const DOMAIN_OPTIONS = [
  { value: "all", label: "All" },
  { value: "hr", label: "HR" },
  { value: "sales", label: "Sales" },
  { value: "finance", label: "Finance" },
  { value: "robotics", label: "Robotics" },
  { value: "healthcare", label: "Healthcare" },
  { value: "ai", label: "AI" },
];

const ROLE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "engineer", label: "Software Engineer" },
  { value: "frontend", label: "Frontend" },
  { value: "backend", label: "Backend" },
  { value: "fullstack", label: "Full Stack" },
  { value: "devops", label: "DevOps/SRE" },
  { value: "data", label: "Data" },
  { value: "ml", label: "ML/AI" },
];

// The seeded company universe is large-cap (all >$1B), so the primary revenue
// buckets are the dataset bands. They filter against companies.revenue_band via
// the `revenueBand` query param. The legacy sub-$1B buckets remain available
// for non-seeded companies and use the `revenueCategory` param.
const REVENUE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "band:$1B-$10B", label: "$1B-$10B" },
  { value: "band:$10B-$50B", label: "$10B-$50B" },
  { value: "band:$50B-$100B", label: "$50B-$100B" },
  { value: "band:$100B-$250B", label: "$100B-$250B" },
  { value: "band:$250B-$500B", label: "$250B-$500B" },
  { value: "band:$500B+", label: "$500B+" },
  { value: "lt_50m", label: "<50M" },
  { value: "50m_100m", label: "50M-100M" },
  { value: "100m_600m", label: "100M-600M" },
  { value: "600m_1b", label: "600M-1B" },
  { value: "gt_1b", label: "1B+" },
];

const DOMAIN_QUERY_KEYWORDS: Array<[string, string[]]> = [
  ["hr", ["hr", "human resources"]],
  ["sales", ["sales"]],
  ["finance", ["finance"]],
  ["robotics", ["drone", "robotics", "robot"]],
  ["healthcare", ["healthcare", "health care"]],
  ["ai", ["ai", "ml", "machine learning"]],
];

const ROLE_QUERY_KEYWORDS: Array<[string, string[]]> = [
  ["backend", ["backend", "back-end", "back end"]],
  ["frontend", ["frontend", "front-end", "front end"]],
  ["fullstack", ["fullstack", "full-stack", "full stack"]],
  ["devops", ["devops", "dev-ops", "sre"]],
  ["data", ["data"]],
  ["ml", ["ml", "ai"]],
  ["engineer", ["engineer", "developer", "software engineer"]],
];

function parseQuery(query: string): SmartQuery {
  const value = query.trim().toLowerCase();
  if (!value) return {};

  let detectedDomain: string | undefined;
  for (const [domain, keys] of DOMAIN_QUERY_KEYWORDS) {
    if (keys.some((key) => value.includes(key))) {
      detectedDomain = domain;
      break;
    }
  }

  let detectedRole: string | undefined;
  for (const [role, keys] of ROLE_QUERY_KEYWORDS) {
    if (keys.some((key) => value.includes(key))) {
      detectedRole = role;
      break;
    }
  }

  return { detectedDomain, detectedRole };
}

export default function CompaniesPage() {
  const [items, setItems] = React.useState<CompanyResult[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [domain, setDomain] = React.useState("all");
  const [role, setRole] = React.useState("all");
  const [revenueCategory, setRevenueCategory] = React.useState("all");
  const [sort, setSort] = React.useState<SortKey>("job_count_desc");
  const [page, setPage] = React.useState(1);

  const smartQuery = React.useMemo(() => parseQuery(q), [q]);
  const effectiveDomain = domain === "all" ? smartQuery.detectedDomain ?? "all" : domain;
  const effectiveRole = role === "all" ? smartQuery.detectedRole ?? "all" : role;
  const selectedRevenueLabel =
    REVENUE_OPTIONS.find((option) => option.value === revenueCategory)?.label ?? "All";

  React.useEffect(() => {
    const controller = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      setError(null);

      const fetchCompanies = async (searchParams: URLSearchParams) => {
        const response = await fetch(`/api/companies?${searchParams.toString()}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.json().catch(() => null);
          const msg =
            body && typeof body.error === "string"
              ? body.error
              : `Failed: ${response.status}`;
          throw new Error(msg);
        }

        return (await response.json()) as PageResponse;
      };

      const params = new URLSearchParams();
      // Company-universe view: surface monitored/seeded companies even when they
      // currently have 0 active openings, organised by revenue band, each card
      // showing its opening count (0+). isHiring is intentionally omitted so the
      // server does not pre-filter to companies flagged hiring.
      params.set("includeZeroOpenings", "true");
      if (q.trim()) params.set("q", q.trim());
      if (effectiveDomain !== "all") params.set("domain", effectiveDomain);
      if (effectiveRole !== "all") params.set("role", effectiveRole);
      if (revenueCategory !== "all") {
        // "band:" values filter the denormalised companies.revenue_band column
        // (large-cap seed bands); the rest use the legacy numeric category.
        if (revenueCategory.startsWith("band:")) {
          params.set("revenueBand", revenueCategory.slice("band:".length));
        } else {
          params.set("revenueCategory", revenueCategory);
        }
      }

      fetchCompanies(params)
        .then((nextPage) => {
          setItems(nextPage.data ?? []);
        })
        .catch((e: unknown) => {
          if ((e as { name?: string })?.name === "AbortError") return;
          setError(e instanceof Error ? e.message : "Failed to load");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 300);

    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [q, effectiveDomain, effectiveRole, revenueCategory]);

  React.useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      console.log("Companies rendered:", items.length);
    }
  }, [items]);

  const filteredSorted = React.useMemo(() => {
    const totalOpenings = (c: CompanyResult) =>
      Math.max(c.active_openings_total ?? c.jobCount, c.jobCount);
    const sorted = [...items];
    sorted.sort((a, b) => {
      switch (sort) {
        case "job_count_desc":
          return totalOpenings(b) - totalOpenings(a);
        case "job_count_asc":
          return totalOpenings(a) - totalOpenings(b);
        case "name_asc":
          return a.name.localeCompare(b.name);
        case "newest":
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
    });

    return sorted;
  }, [items, sort]);

  React.useEffect(() => {
    setPage(1);
  }, [q, effectiveDomain, effectiveRole, revenueCategory, sort]);

  const filtersActive =
    q.trim().length > 0 ||
    effectiveDomain !== "all" ||
    effectiveRole !== "all" ||
    revenueCategory !== "all";

  const totalPages = Math.max(1, Math.ceil(filteredSorted.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems = React.useMemo(
    () => filteredSorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filteredSorted, currentPage]
  );

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Companies</h1>
          <p className="text-sm text-neutral-500">
            Company-aggregated results with smart domain and role filtering.
          </p>
        </div>
      </header>

      <div className="sticky top-0 z-20 border-b border-neutral-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
        <div className="flex flex-col gap-3 py-3">
          <SearchBar
            value={q}
            onChange={setQ}
            detectedDomain={smartQuery.detectedDomain}
            detectedRole={smartQuery.detectedRole}
          />

          {/* Filters collapse into an accordion under 768px (tap the summary to
              expand) and are always visible on md+ so the desktop layout is
              unchanged. The summary is hidden on md+, and the filter group is
              force-shown on md+ regardless of the <details> open state. */}
          <details className="group">
            <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between rounded-md border border-neutral-200 px-3 text-sm font-medium text-neutral-700 md:hidden">
              <span>Filters{filtersActive ? " · active" : ""}</span>
              <span className="text-xs text-neutral-500 transition-transform group-open:rotate-180">▾</span>
            </summary>
            <div className="mt-3 hidden flex-col gap-3 group-open:flex md:mt-0 md:flex">
              <RevenueFilter
                options={REVENUE_OPTIONS}
                value={revenueCategory}
                onChange={setRevenueCategory}
              />
              <DomainFilter options={DOMAIN_OPTIONS} value={effectiveDomain} onChange={setDomain} />
              <RoleFilter options={ROLE_OPTIONS} value={effectiveRole} onChange={setRole} />
            </div>
          </details>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-neutral-500">
              {filteredSorted.length} compan{filteredSorted.length === 1 ? "y" : "ies"} matched
              {" "}· showing {PAGE_SIZE} per page. Revenue filter: {selectedRevenueLabel}.
            </p>
            <div className="flex items-center gap-2">
              <label htmlFor="sort" className="text-xs uppercase tracking-wide text-neutral-500">
                Sort
              </label>
              <Select
                id="sort"
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="h-10 min-h-[40px] w-full sm:w-auto"
              >
                <option value="job_count_desc">Open roles ↓</option>
                <option value="job_count_asc">Open roles ↑</option>
                <option value="name_asc">Name A-Z</option>
                <option value="newest">Newest</option>
              </Select>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10 text-sm text-neutral-600">Loading jobs...</div>
      ) : filteredSorted.length === 0 ? (
        <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-700">
          No companies match the current filters.
          {revenueCategory !== "all" && (
            <span> Try a different revenue range or switch Revenue to All.</span>
          )}
        </div>
      ) : (
        <>
          <CompanyList companies={pageItems} filtersActive={filtersActive} />
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4 py-4">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
                className="inline-flex min-h-[40px] items-center rounded-md border border-neutral-300 px-4 text-sm font-medium disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-sm tabular-nums text-neutral-600">
                Page {currentPage} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
                className="inline-flex min-h-[40px] items-center rounded-md border border-neutral-300 px-4 text-sm font-medium disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
