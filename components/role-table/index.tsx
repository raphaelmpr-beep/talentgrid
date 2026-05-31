"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PocDrawer, type ChampionPOC } from "@/components/poc-drawer";
import { cn, formatRelative } from "@/lib/utils";

export type RoleRow = {
  id: string;
  company_id: string;
  title: string;
  location?: string | null;
  remote?: boolean;
  employment_type?: string | null;
  seniority?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  url?: string | null;
  ghost_score?: number;
  posted_at?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type RoleTableProps = {
  roles: RoleRow[];
  emptyMessage?: string;
};

function extractPOC(role: RoleRow): ChampionPOC | null {
  const m = role.metadata ?? {};
  const raw = (m["champion"] ?? m["poc"] ?? m["hiring_manager"]) as
    | Partial<ChampionPOC>
    | undefined;
  if (!raw || !raw.name) return null;
  return {
    name: raw.name,
    title: raw.title ?? null,
    email: raw.email ?? null,
    linkedin: raw.linkedin ?? null,
    phone: raw.phone ?? null,
    tags: raw.tags ?? [],
  };
}

function ghostBadge(score: number | undefined): React.ReactNode {
  const s = score ?? 0;
  if (s < 20)
    return <Badge variant="success">Fresh</Badge>;
  if (s < 40)
    return <Badge variant="secondary">Active</Badge>;
  if (s < 70)
    return <Badge variant="warning">Stale</Badge>;
  return <Badge variant="danger">Ghost</Badge>;
}

function salaryLabel(role: RoleRow): string | null {
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

export function RoleTable({ roles, emptyMessage }: RoleTableProps) {
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [drawer, setDrawer] = React.useState<{
    open: boolean;
    poc: ChampionPOC | null;
    role: RoleRow | null;
  }>({ open: false, poc: null, role: null });

  if (!roles.length) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500">
        {emptyMessage ?? "No roles to show."}
      </div>
    );
  }

  const renderDetails = (role: RoleRow, poc: ChampionPOC | null) => (
    <div className="grid gap-4 md:grid-cols-3">
      <div className="md:col-span-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Quick actions
        </h4>
        <div className="mt-2 flex flex-wrap gap-2">
          {role.url && (
            <a
              href={role.url}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-blue-600 hover:underline"
            >
              View posting ↗
            </a>
          )}
        </div>
      </div>
      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Champion
        </h4>
        <div
          className={cn(
            "mt-2 rounded-md border p-3",
            poc
              ? "border-neutral-200 bg-white"
              : "border-dashed border-neutral-300 bg-transparent"
          )}
        >
          {poc ? (
            <>
              <div className="text-sm font-medium">{poc.name}</div>
              {poc.title && (
                <div className="text-xs text-neutral-500">{poc.title}</div>
              )}
              <Button
                className="mt-2"
                size="sm"
                onClick={() => setDrawer({ open: true, poc, role })}
              >
                Open POC
              </Button>
            </>
          ) : (
            <div className="text-xs text-neutral-500">
              No champion identified yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile: stacked cards (no horizontal-scrolling table). */}
      <ul className="space-y-3 md:hidden">
        {roles.map((role) => {
          const poc = extractPOC(role);
          const isOpen = expanded === role.id;
          return (
            <li
              key={role.id}
              className="rounded-lg border border-neutral-200 bg-white p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="break-words font-medium text-neutral-900">
                    {role.title}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1 text-xs text-neutral-500">
                    {role.seniority && <span>{role.seniority}</span>}
                    {role.employment_type && (
                      <>
                        <span>·</span>
                        <span>{role.employment_type}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="shrink-0">{ghostBadge(role.ghost_score)}</div>
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-xs uppercase tracking-wide text-neutral-400">
                  Location
                </dt>
                <dd className="text-right text-neutral-700">
                  {role.location ?? (role.remote ? "Remote" : "—")}
                  {role.remote && role.location && (
                    <span className="ml-1 text-xs text-neutral-500">
                      (remote ok)
                    </span>
                  )}
                </dd>
                <dt className="text-xs uppercase tracking-wide text-neutral-400">
                  Compensation
                </dt>
                <dd className="text-right text-neutral-700">
                  {salaryLabel(role) ?? "—"}
                </dd>
                <dt className="text-xs uppercase tracking-wide text-neutral-400">
                  Posted
                </dt>
                <dd className="text-right text-neutral-500">
                  {formatRelative(role.posted_at) || "—"}
                </dd>
              </dl>

              <div className="mt-3 flex flex-col gap-2">
                {role.url && (
                  <a
                    href={role.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-neutral-900 px-3 text-sm font-medium text-white transition-colors hover:bg-neutral-800"
                  >
                    Apply ↗
                  </a>
                )}
                <Button
                  variant="outline"
                  className="min-h-[44px] w-full"
                  onClick={() =>
                    setExpanded((cur) => (cur === role.id ? null : role.id))
                  }
                  aria-expanded={isOpen}
                >
                  {isOpen ? "Hide details" : "Details"}
                </Button>
              </div>

              {isOpen && (
                <div className="mt-3 border-t border-neutral-100 pt-3">
                  {renderDetails(role, poc)}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {/* Desktop/tablet: full table (unchanged layout). */}
      <div className="hidden overflow-hidden rounded-lg border border-neutral-200 bg-white md:block">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Role</th>
              <th className="px-4 py-2 text-left font-medium">Location</th>
              <th className="px-4 py-2 text-left font-medium">Compensation</th>
              <th className="px-4 py-2 text-left font-medium">Status</th>
              <th className="px-4 py-2 text-left font-medium">Posted</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => {
              const poc = extractPOC(role);
              const isOpen = expanded === role.id;
              return (
                <React.Fragment key={role.id}>
                  <tr className="border-t border-neutral-100 hover:bg-neutral-50">
                    <td className="px-4 py-3 align-top">
                      <div className="font-medium text-neutral-900">
                        {role.title}
                      </div>
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
                    <td className="px-4 py-3 align-top text-neutral-700">
                      {role.location ?? (role.remote ? "Remote" : "—")}
                      {role.remote && role.location && (
                        <span className="ml-1 text-xs text-neutral-500">
                          (remote ok)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top text-neutral-700">
                      {salaryLabel(role) ?? "—"}
                    </td>
                    <td className="px-4 py-3 align-top">
                      {ghostBadge(role.ghost_score)}
                    </td>
                    <td className="px-4 py-3 align-top text-neutral-500">
                      {formatRelative(role.posted_at) || "—"}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setExpanded((cur) => (cur === role.id ? null : role.id))
                        }
                        aria-expanded={isOpen}
                      >
                        {isOpen ? "Hide" : "Details"}
                      </Button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-t border-neutral-100 bg-neutral-50/60">
                      <td colSpan={6} className="px-4 py-4">
                        {renderDetails(role, poc)}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <PocDrawer
        open={drawer.open}
        onClose={() => setDrawer((d) => ({ ...d, open: false }))}
        companyId={drawer.role?.company_id}
        roleTitle={drawer.role?.title}
        poc={drawer.poc}
      />
    </>
  );
}

export default RoleTable;
