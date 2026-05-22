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
import { formatCompactNumber } from "@/lib/utils";

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
  created_at: string;
};

type Page<T> = { data: T[]; page: number; pageSize: number; total: number };

const ROLE_FAMILIES = [
  { value: "all", label: "All" },
  { value: "engineering", label: "Engineering" },
  { value: "product", label: "Product" },
  { value: "design", label: "Design" },
  { value: "sales", label: "Sales" },
  { value: "ops", label: "Ops" },
];

type SortKey = "hiring_desc" | "hiring_asc" | "name_asc" | "newest";

const DEFAULT_MIN_REVENUE = 100_000_000;
const DEFAULT_MAX_REVENUE = 600_000_000;
const DEFAULT_PAGE_SIZE = 20;

function hiringVolume(c: Company): number {
  const m = (c.metadata ?? {}) as Record<string, unknown>;
  const direct = m["open_roles_count"] ?? m["hiring_volume"] ?? m["open_roles"];
  return typeof direct === "number" ? direct : 0;
}

function rolesByFamily(c: Company): Record<string, number> {
  const m = (c.metadata ?? {}) as Record<string, unknown>;
  const raw = m["role_families"];
  return (raw && typeof raw === "object" ? (raw as Record<string, number>) : {}) ?? {};
}

export default function CompaniesPage() {
  const [items, setItems] = React.useState<Company[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [debouncedQ, setDebouncedQ] = React.useState("");
  const [hiringOnly, setHiringOnly] = React.useState(true);
  const [family, setFamily] = React.useState("all");
  const [sort, setSort] = React.useState<SortKey>("hiring_desc");
  const [minRevenue, setMinRevenue] = React.useState<number>(DEFAULT_MIN_REVENUE);
  const [maxRevenue, setMaxRevenue] = React.useState<number>(DEFAULT_MAX_REVENUE);
  const [minRevenueInput, setMinRevenueInput] = React.useState<string>(
    String(DEFAULT_MIN_REVENUE)
  );
  const [maxRevenueInput, setMaxRevenueInput] = React.useState<string>(
    String(DEFAULT_MAX_REVENUE)
  );

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set("pageSize", String(DEFAULT_PAGE_SIZE));
    if (debouncedQ) params.set("q", debouncedQ);
    if (!hiringOnly) params.set("isHiring", "false");
    params.set("minRevenue", String(minRevenue));
    params.set("maxRevenue", String(maxRevenue));
    fetch(`/api/companies?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`Failed: ${r.status}`);
        return (await r.json()) as Page<Company>;
      })
      .then((page) => {
        if (!cancelled) setItems(page.data ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQ, hiringOnly, minRevenue, maxRevenue]);

  const filteredSorted = React.useMemo(() => {
    let rows = items;
    if (family !== "all") {
      rows = rows.filter((c) => {
        const fam = rolesByFamily(c);
        return (fam[family] ?? 0) > 0;
      });
    }
    const sorted = [...rows];
    sorted.sort((a, b) => {
      switch (sort) {
        case "hiring_desc":
          return hiringVolume(b) - hiringVolume(a);
        case "hiring_asc":
          return hiringVolume(a) - hiringVolume(b);
        case "name_asc":
          return a.name.localeCompare(b.name);
        case "newest":
          return (
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          );
      }
    });
    return sorted;
  }, [items, family, sort]);

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
          <ToggleGroup
            value={family}
            onChange={setFamily}
            options={ROLE_FAMILIES}
          />
          <div className="flex items-center gap-2">
            <label
              htmlFor="minRevenue"
              className="text-xs uppercase tracking-wide text-neutral-500"
            >
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
            <span className="text-neutral-400">–</span>
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
              className="w-32"
              aria-label="Maximum annual revenue"
            />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <label
              htmlFor="sort"
              className="text-xs uppercase tracking-wide text-neutral-500"
            >
              Sort
            </label>
            <Select
              id="sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
            >
              <option value="hiring_desc">Hiring volume ↓</option>
              <option value="hiring_asc">Hiring volume ↑</option>
              <option value="name_asc">Name A–Z</option>
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
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : filteredSorted.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-500">
          No companies match your filters.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredSorted.map((c) => {
            const volume = hiringVolume(c);
            const families = rolesByFamily(c);
            const topFamilies = Object.entries(families)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3);
            return (
              <Link
                key={c.id}
                href={`/companies/${c.id}`}
                className="group block"
              >
                <Card className="h-full transition-shadow group-hover:shadow-md">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-neutral-100 text-sm font-semibold text-neutral-600">
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
                        <div className="flex items-center gap-2">
                          <h2 className="truncate text-base font-semibold">
                            {c.name}
                          </h2>
                          {c.is_hiring && (
                            <Badge variant="success">Hiring</Badge>
                          )}
                        </div>
                        <p className="truncate text-xs text-neutral-500">
                          {c.industry ?? c.domain ?? c.location ?? ""}
                        </p>
                      </div>
                    </div>
                    {c.description && (
                      <p className="mt-3 line-clamp-2 text-sm text-neutral-600">
                        {c.description}
                      </p>
                    )}
                    <div className="mt-4 flex items-center justify-between">
                      <div className="flex flex-wrap gap-1">
                        {topFamilies.map(([fam, n]) => (
                          <Badge key={fam} variant="outline">
                            {fam} · {n}
                          </Badge>
                        ))}
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-semibold tabular-nums">
                          {formatCompactNumber(volume)}
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-neutral-500">
                          open roles
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
