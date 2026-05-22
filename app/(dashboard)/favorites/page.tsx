"use client";

import * as React from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { formatRelative } from "@/lib/utils";

type Favorite = {
  id: string;
  company_id: string | null;
  role_id: string | null;
  notes: string | null;
  created_at: string;
};

type Company = {
  id: string;
  name: string;
  logo_url?: string | null;
  industry?: string | null;
  location?: string | null;
  is_hiring: boolean;
};

type Role = {
  id: string;
  company_id: string;
  title: string;
  location?: string | null;
  remote?: boolean;
  seniority?: string | null;
  posted_at?: string | null;
};

type Page<T> = { data: T[]; total: number };

export default function FavoritesPage() {
  const [favorites, setFavorites] = React.useState<Favorite[]>([]);
  const [companies, setCompanies] = React.useState<Map<string, Company>>(
    new Map()
  );
  const [roles, setRoles] = React.useState<Map<string, Role>>(new Map());
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/favorites?pageSize=100");
        if (res.status === 401)
          throw new Error("Sign in to view your favorites.");
        if (!res.ok) throw new Error(`Failed: ${res.status}`);
        const page = (await res.json()) as Page<Favorite>;
        if (cancelled) return;
        const favs = page.data ?? [];
        setFavorites(favs);

        const companyIds = Array.from(
          new Set(favs.map((f) => f.company_id).filter(Boolean) as string[])
        );
        const roleIds = Array.from(
          new Set(favs.map((f) => f.role_id).filter(Boolean) as string[])
        );

        const tasks: Promise<void>[] = [];

        if (companyIds.length) {
          tasks.push(
            (async () => {
              const map = new Map<string, Company>();
              const res = await fetch(
                `/api/companies?pageSize=100&isHiring=false`
              ).catch(() => null);
              if (res && res.ok) {
                const list = (await res.json()) as Page<Company>;
                for (const c of list.data ?? []) {
                  if (companyIds.includes(c.id)) map.set(c.id, c);
                }
              }
              if (!cancelled) setCompanies(map);
            })()
          );
        }

        if (roleIds.length) {
          tasks.push(
            (async () => {
              const map = new Map<string, Role>();
              const all = await fetch(`/api/roles?pageSize=100`).catch(() => null);
              if (all && all.ok) {
                const list = (await all.json()) as Page<Role>;
                for (const r of list.data ?? []) {
                  if (roleIds.includes(r.id)) map.set(r.id, r);
                }
              }
              if (!cancelled) setRoles(map);
            })()
          );
        }

        await Promise.all(tasks);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const savedCompanies = favorites.filter((f) => f.company_id);
  const savedRoles = favorites.filter((f) => f.role_id);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Favorites</h1>
        <p className="text-sm text-neutral-500">
          Companies and roles you&apos;ve starred.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <Tabs defaultValue="companies">
        <TabsList>
          <TabsTrigger value="companies">
            Companies
            <span className="ml-2 rounded bg-neutral-200 px-1.5 text-xs">
              {savedCompanies.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="roles">
            Roles
            <span className="ml-2 rounded bg-neutral-200 px-1.5 text-xs">
              {savedRoles.length}
            </span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="companies">
          {loading ? (
            <SkeletonGrid />
          ) : savedCompanies.length === 0 ? (
            <Empty message="No saved companies yet." />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {savedCompanies.map((fav) => {
                const c = fav.company_id ? companies.get(fav.company_id) : null;
                return (
                  <Link
                    key={fav.id}
                    href={c ? `/companies/${c.id}` : "#"}
                    className="block"
                  >
                    <Card className="h-full transition-shadow hover:shadow-md">
                      <CardContent className="p-4">
                        <div className="flex items-start gap-3">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-neutral-100 text-sm font-semibold text-neutral-600">
                            {c?.logo_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={c.logo_url}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              (c?.name ?? "?").slice(0, 1).toUpperCase()
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <h3 className="truncate text-sm font-semibold">
                                {c?.name ?? "Unknown company"}
                              </h3>
                              {c?.is_hiring && (
                                <Badge variant="success">Hiring</Badge>
                              )}
                            </div>
                            <p className="truncate text-xs text-neutral-500">
                              {c?.industry ?? c?.location ?? ""}
                            </p>
                          </div>
                        </div>
                        {fav.notes && (
                          <p className="mt-3 line-clamp-2 text-xs text-neutral-600">
                            {fav.notes}
                          </p>
                        )}
                        <div className="mt-3 text-[10px] uppercase tracking-wide text-neutral-400">
                          Saved {formatRelative(fav.created_at)}
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="roles">
          {loading ? (
            <SkeletonGrid />
          ) : savedRoles.length === 0 ? (
            <Empty message="No saved roles yet." />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {savedRoles.map((fav) => {
                const r = fav.role_id ? roles.get(fav.role_id) : null;
                return (
                  <Card key={fav.id} className="h-full">
                    <CardContent className="p-4">
                      <h3 className="text-sm font-semibold">
                        {r?.title ?? "Unknown role"}
                      </h3>
                      <p className="mt-0.5 text-xs text-neutral-500">
                        {r?.seniority ?? ""}
                        {r?.location ? ` · ${r.location}` : ""}
                        {r?.remote ? " · Remote" : ""}
                      </p>
                      {r && (
                        <Link
                          href={`/companies/${r.company_id}`}
                          className="mt-3 inline-block text-xs text-blue-600 hover:underline"
                        >
                          View company →
                        </Link>
                      )}
                      {fav.notes && (
                        <p className="mt-2 line-clamp-2 text-xs text-neutral-600">
                          {fav.notes}
                        </p>
                      )}
                      <div className="mt-3 text-[10px] uppercase tracking-wide text-neutral-400">
                        Saved {formatRelative(fav.created_at)}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-32 w-full" />
      ))}
    </div>
  );
}

function Empty({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-500">
      {message}
    </div>
  );
}
