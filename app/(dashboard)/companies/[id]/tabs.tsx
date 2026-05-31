"use client";

import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RoleTable, type RoleRow } from "@/components/role-table";
import { SignalFeed } from "@/components/signal-feed";

type Company = {
  id: string;
  name: string;
  domain?: string | null;
  description?: string | null;
  industry?: string | null;
  size?: string | null;
  location?: string | null;
  website?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export function CompanyDetailTabs({
  company,
  activeRoles,
  ghostRoles,
}: {
  company: Company;
  activeRoles: RoleRow[];
  ghostRoles: RoleRow[];
}) {
  const metadata = (company.metadata ?? {}) as Record<string, unknown>;
  const fundingRaw = metadata["funding"];
  const funding = Array.isArray(fundingRaw)
    ? (fundingRaw as Array<{
        round?: string;
        amount?: number;
        date?: string;
        investors?: string[];
      }>)
    : [];
  const newsRaw = metadata["news"];
  const news = Array.isArray(newsRaw)
    ? (newsRaw as Array<{ title?: string; url?: string; date?: string; source?: string }>)
    : [];
  const peopleRaw = metadata["people"];
  const people = Array.isArray(peopleRaw)
    ? (peopleRaw as Array<{ name?: string; title?: string; linkedin?: string }>)
    : [];

  const families = activeRoles.reduce<Record<string, number>>((acc, r) => {
    const fam = (r.metadata?.["role_family"] as string) ?? "other";
    acc[fam] = (acc[fam] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <Tabs defaultValue="overview">
      <TabsList className="flex flex-wrap">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="roles">
          Roles
          <span className="ml-2 rounded bg-neutral-200 px-1.5 text-xs">
            {activeRoles.length}
          </span>
        </TabsTrigger>
        <TabsTrigger value="ghosts">
          Ghosts
          <span className="ml-2 rounded bg-neutral-200 px-1.5 text-xs">
            {ghostRoles.length}
          </span>
        </TabsTrigger>
        <TabsTrigger value="people">People</TabsTrigger>
        <TabsTrigger value="funding">Funding & News</TabsTrigger>
        <TabsTrigger value="signals">Signals</TabsTrigger>
      </TabsList>

      <TabsContent value="overview">
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardContent className="space-y-4 p-6">
              <section>
                <h3 className="text-sm font-semibold">About</h3>
                <p className="mt-2 text-sm text-neutral-700">
                  {company.description ?? "No description on file."}
                </p>
              </section>
              <section>
                <h3 className="text-sm font-semibold">Role distribution</h3>
                {Object.keys(families).length === 0 ? (
                  <p className="mt-2 text-sm text-neutral-500">
                    No active roles to summarize.
                  </p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {Object.entries(families)
                      .sort((a, b) => b[1] - a[1])
                      .map(([fam, n]) => (
                        <Badge key={fam} variant="outline">
                          {fam} · {n}
                        </Badge>
                      ))}
                  </div>
                )}
              </section>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-3 p-6">
              <h3 className="text-sm font-semibold">Quick facts</h3>
              <dl className="space-y-2 text-sm">
                <Fact label="Domain" value={company.domain ?? undefined} />
                <Fact label="Industry" value={company.industry ?? undefined} />
                <Fact label="Size" value={company.size ?? undefined} />
                <Fact label="HQ" value={company.location ?? undefined} />
              </dl>
            </CardContent>
          </Card>
        </div>
      </TabsContent>

      <TabsContent value="roles">
        <RoleTable
          roles={activeRoles}
          emptyMessage="No active roles posted right now."
          companyName={company.name}
          companyDomain={company.domain}
        />
      </TabsContent>

      <TabsContent value="ghosts">
        <RoleTable
          roles={ghostRoles}
          emptyMessage="No ghost roles detected. ✨"
          companyName={company.name}
          companyDomain={company.domain}
        />
      </TabsContent>

      <TabsContent value="people">
        {people.length === 0 ? (
          <EmptyState message="No people data yet." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {people.map((p, i) => (
              <Card key={`${p.name ?? "p"}-${i}`}>
                <CardContent className="p-4">
                  <div className="text-sm font-semibold">
                    {p.name ?? "Unknown"}
                  </div>
                  {p.title && (
                    <div className="text-xs text-neutral-500">{p.title}</div>
                  )}
                  {p.linkedin && (
                    <a
                      href={p.linkedin}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block text-xs text-blue-600 hover:underline"
                    >
                      LinkedIn ↗
                    </a>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="funding">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardContent className="p-6">
              <h3 className="mb-3 text-sm font-semibold">Funding</h3>
              {funding.length === 0 ? (
                <EmptyState message="No funding rounds on file." />
              ) : (
                <ul className="space-y-2 text-sm">
                  {funding.map((f, i) => (
                    <li
                      key={i}
                      className="flex items-baseline justify-between gap-2 border-b border-neutral-100 pb-2 last:border-0"
                    >
                      <div>
                        <div className="font-medium">{f.round ?? "Round"}</div>
                        {f.investors && (
                          <div className="text-xs text-neutral-500">
                            {f.investors.join(", ")}
                          </div>
                        )}
                      </div>
                      <div className="text-right text-xs">
                        <div className="font-semibold tabular-nums">
                          {f.amount
                            ? new Intl.NumberFormat("en", {
                                style: "currency",
                                currency: "USD",
                                notation: "compact",
                              }).format(f.amount)
                            : "—"}
                        </div>
                        {f.date && (
                          <div className="text-neutral-500">{f.date}</div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <h3 className="mb-3 text-sm font-semibold">News</h3>
              {news.length === 0 ? (
                <EmptyState message="No recent news." />
              ) : (
                <ul className="space-y-2 text-sm">
                  {news.map((n, i) => (
                    <li key={i} className="border-b border-neutral-100 pb-2 last:border-0">
                      {n.url ? (
                        <a
                          href={n.url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium text-blue-600 hover:underline"
                        >
                          {n.title ?? n.url}
                        </a>
                      ) : (
                        <span className="font-medium">{n.title}</span>
                      )}
                      <div className="text-xs text-neutral-500">
                        {[n.source, n.date].filter(Boolean).join(" · ")}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </TabsContent>

      <TabsContent value="signals">
        <Card>
          <CardContent className="p-6">
            <SignalFeed companyId={company.id} />
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}

function Fact({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </dt>
      <dd className="text-right text-neutral-800">{value ?? "—"}</dd>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500">
      {message}
    </div>
  );
}
