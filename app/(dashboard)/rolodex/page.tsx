"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

type RolodexEntry = {
  id: string;
  company_id?: string | null;
  name: string;
  title?: string | null;
  email?: string | null;
  linkedin?: string | null;
  phone?: string | null;
  notes?: string | null;
  tags: string[];
  company_name?: string | null;
  job_title?: string | null;
  contact_path_label?: string | null;
  verification_status?: string | null;
  confidence_level?: string | null;
  created_at: string;
};

const VERIFICATION_LABEL: Record<string, string> = {
  manual_review_required: "Manual review required",
  manually_verified: "Verified",
  unverified: "Unverified",
};

type Page<T> = { data: T[]; page: number; pageSize: number; total: number };

export default function RolodexPage() {
  const [items, setItems] = React.useState<RolodexEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [debouncedQ, setDebouncedQ] = React.useState("");

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set("pageSize", "100");
    if (debouncedQ) params.set("q", debouncedQ);
    fetch(`/api/rolodex?${params.toString()}`)
      .then(async (r) => {
        if (r.status === 401) throw new Error("Sign in to view your rolodex.");
        if (!r.ok) throw new Error(`Failed: ${r.status}`);
        return (await r.json()) as Page<RolodexEntry>;
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
  }, [debouncedQ]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Rolodex</h1>
          <p className="text-sm text-neutral-500">
            Contacts you&apos;ve saved across companies and roles.
          </p>
        </div>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search contacts…"
          className="max-w-xs"
          aria-label="Search rolodex"
        />
      </header>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-500">
          Your rolodex is empty. Save a contact from a role&apos;s POC drawer to get started.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((entry) => (
            <RolodexCard key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

function RolodexCard({ entry }: { entry: RolodexEntry }) {
  return (
    <Card className="h-full">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-sm font-semibold text-neutral-600">
            {entry.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{entry.name}</div>
            {entry.title && (
              <div className="truncate text-xs text-neutral-500">
                {entry.title}
              </div>
            )}
            {(entry.company_name || entry.job_title) && (
              <div className="truncate text-xs text-neutral-500">
                {[entry.company_name, entry.job_title]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            )}
          </div>
        </div>
        {entry.contact_path_label && (
          <div className="mt-3 text-xs">
            <span className="uppercase tracking-wide text-neutral-400">
              Contact path
            </span>{" "}
            <span className="text-neutral-600">{entry.contact_path_label}</span>
          </div>
        )}
        <div className="mt-3 space-y-1 text-xs">
          {entry.email && (
            <a
              href={`mailto:${entry.email}`}
              className="block truncate text-blue-600 hover:underline"
            >
              {entry.email}
            </a>
          )}
          {entry.linkedin && (
            <a
              href={entry.linkedin}
              target="_blank"
              rel="noreferrer"
              className="block truncate text-blue-600 hover:underline"
            >
              LinkedIn ↗
            </a>
          )}
          {entry.phone && (
            <div className="text-neutral-600">{entry.phone}</div>
          )}
        </div>
        {entry.notes && (
          <p className="mt-3 line-clamp-3 text-xs text-neutral-600">
            {entry.notes}
          </p>
        )}
        {entry.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {entry.tags.map((t) => (
              <Badge key={t} variant="outline">
                {t}
              </Badge>
            ))}
          </div>
        )}
        {entry.verification_status && (
          <div className="mt-3">
            <Badge
              variant={
                entry.verification_status === "manually_verified"
                  ? "success"
                  : "warning"
              }
            >
              {VERIFICATION_LABEL[entry.verification_status] ??
                entry.verification_status}
            </Badge>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
