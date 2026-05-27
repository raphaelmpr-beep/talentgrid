"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select } from "@/components/ui/select";
import { SearchBar } from "@/components/SearchBar";
import { DomainFilter } from "@/components/DomainFilter";
import { RoleFilter } from "@/components/RoleFilter";
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
  const [debouncedQ, setDebouncedQ] = React.useState("");
  const [domain, setDomain] = React.useState("all");
  const [role, setRole] = React.useState("all");
  const [sort, setSort] = React.useState<SortKey>("job_count_desc");

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const smartQuery = React.useMemo(() => parseQuery(debouncedQ), [debouncedQ]);
  const effectiveDomain = domain === "all" ? smartQuery.detectedDomain ?? "all" : domain;
  const effectiveRole = role === "all" ? smartQuery.detectedRole ?? "all" : role;

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    params.set("isHiring", "true");
    if (debouncedQ) params.set("q", debouncedQ);
    if (effectiveDomain !== "all") params.set("domain", effectiveDomain);
    if (effectiveRole !== "all") params.set("role", effectiveRole);

    fetch(`/api/companies?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => null);
          const msg =
            body && typeof body.error === "string"
              ? body.error
              : `Failed: ${r.status}`;
          throw new Error(msg);
        }
        return (await r.json()) as PageResponse;
      })
      .then((nextPage) => {
        if (cancelled) return;
        setItems(nextPage.data ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQ, effectiveDomain, effectiveRole]);

  const filteredSorted = React.useMemo(() => {
    const sorted = [...items];
    sorted.sort((a, b) => {
      switch (sort) {
        case "job_count_desc":
          return b.jobCount - a.jobCount;
        case "job_count_asc":
          return a.jobCount - b.jobCount;
        case "name_asc":
          return a.name.localeCompare(b.name);
        case "newest":
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
    });

    return sorted;
  }, [items, sort]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Companies</h1>
          <p className="text-sm text-neutral-500">
            Company-aggregated results with smart domain and role filtering.
          </p>
        </div>
      </header>

      <Card className="sticky top-0 z-20 border-neutral-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
        <CardContent className="space-y-4 p-4">
          <SearchBar
            value={q}
            onChange={setQ}
            detectedDomain={smartQuery.detectedDomain}
            detectedRole={smartQuery.detectedRole}
          />
          <DomainFilter options={DOMAIN_OPTIONS} value={effectiveDomain} onChange={setDomain} />
          <RoleFilter options={ROLE_OPTIONS} value={effectiveRole} onChange={setRole} />

          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-neutral-500">Showing all matching results with no hard cap.</p>
            <div className="flex items-center gap-2">
              <label htmlFor="sort" className="text-xs uppercase tracking-wide text-neutral-500">
                Sort
              </label>
              <Select id="sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                <option value="job_count_desc">Open roles ↓</option>
                <option value="job_count_asc">Open roles ↑</option>
                <option value="name_asc">Name A-Z</option>
                <option value="newest">Newest</option>
              </Select>
            </div>
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
            <Skeleton key={i} className="h-44 w-full" />
          ))}
        </div>
      ) : (
        <CompanyList companies={filteredSorted} />
      )}
    </div>
  );
}
