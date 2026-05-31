"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PocDrawer, type ChampionPOC } from "@/components/poc-drawer";
import {
  FindContactDrawer,
  type FindContactTarget,
} from "@/components/find-contact-drawer";
import { getContactPath } from "@/lib/recruiter-intel/contact-path";
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
  // Compensation captured from an ATS/API source (numeric columns may arrive as
  // strings from postgres). status/period drive how the cell is rendered.
  compensation_min?: number | string | null;
  compensation_max?: number | string | null;
  compensation_currency?: string | null;
  compensation_period?: string | null;
  compensation_text?: string | null;
  compensation_source?: string | null;
  compensation_status?: string | null;
  url?: string | null;
  ghost_score?: number;
  posted_at?: string | null;
  posted_status?: string | null;
  discovered_at?: string | null;
  last_seen_at?: string | null;
  role_category?: string | null;
  domain_category?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type RoleTableProps = {
  roles: RoleRow[];
  emptyMessage?: string;
  // Company context for Recruiter Intel routing + search links. Optional so the
  // table still renders everywhere; the contact path falls back gracefully.
  companyName?: string | null;
  companyDomain?: string | null;
};

// Resolve the lightweight CONTACT PATH label shown under each role. Routing is
// pure (lib/recruiter-intel) — no scraping, no network.
function contactPathLabel(role: RoleRow): string {
  return getContactPath({
    title: role.title,
    role_category: role.role_category,
    domain_category: role.domain_category,
  }).contact_path_label;
}

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

function toNum(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
};

const PERIOD_LABEL: Record<string, string> = {
  year: "year",
  hour: "hour",
  month: "month",
  week: "week",
  contract: "contract",
};

function moneyAmount(n: number, currency: string | null | undefined): string {
  const sym = currency ? CURRENCY_SYMBOL[currency] : undefined;
  const formatted = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
  if (sym) return `${sym}${formatted}`;
  // No known symbol: show the ISO code suffix so the figure is unambiguous.
  return currency ? `${formatted} ${currency}` : `${formatted}`;
}

function periodSuffix(period: string | null | undefined): string {
  const label = period ? PERIOD_LABEL[period] : undefined;
  return label ? ` / ${label}` : "";
}

// Resolve how the Compensation cell should render, driven by compensation_status.
// Returns the display text plus whether to show a small "parsed" tag. Returns
// null only when there is genuinely nothing to show (unavailable / no status),
// in which case the caller renders an em dash. Never fabricates a value.
function compensationDisplay(
  role: RoleRow
): { text: string; parsed: boolean } | null {
  const status = role.compensation_status ?? "unavailable";
  const min = toNum(role.compensation_min);
  const max = toNum(role.compensation_max);
  const currency = role.compensation_currency;
  const suffix = periodSuffix(role.compensation_period);

  switch (status) {
    case "exact_range": {
      if (min !== null && max !== null && min !== max) {
        return {
          text: `${moneyAmount(min, currency)}–${moneyAmount(max, currency)}${suffix}`,
          parsed: false,
        };
      }
      // Fall through defensively to single value if the range collapsed.
      const single = min ?? max;
      if (single !== null) {
        return { text: `${moneyAmount(single, currency)}${suffix}`, parsed: false };
      }
      return role.compensation_text
        ? { text: role.compensation_text, parsed: false }
        : null;
    }
    case "exact_single_value": {
      const single = min ?? max;
      if (single !== null) {
        return { text: `${moneyAmount(single, currency)}${suffix}`, parsed: false };
      }
      return role.compensation_text
        ? { text: role.compensation_text, parsed: false }
        : null;
    }
    case "text_only":
      return role.compensation_text
        ? { text: role.compensation_text, parsed: false }
        : null;
    case "parsed_from_description":
      return role.compensation_text
        ? { text: role.compensation_text, parsed: true }
        : null;
    case "unavailable":
    default:
      // Legacy rows with no compensation_* but a stored salary_min/max still
      // render from the older integer columns so nothing regresses.
      return legacySalary(role);
  }
}

// Backwards-compatible rendering for rows that predate compensation_* and only
// have the integer salary_min/max columns.
function legacySalary(role: RoleRow): { text: string; parsed: boolean } | null {
  const min = toNum(role.salary_min);
  const max = toNum(role.salary_max);
  if (min === null && max === null) return null;
  if (min !== null && max !== null)
    return { text: `${moneyAmount(min, "USD")}–${moneyAmount(max, "USD")}`, parsed: false };
  if (min !== null) return { text: `${moneyAmount(min, "USD")}+`, parsed: false };
  return { text: `up to ${moneyAmount(max!, "USD")}`, parsed: false };
}

// Posted cell: an exact source date renders as a relative "Posted Nd ago"; an
// inferred-from-discovery date renders as "Discovered Nd ago" (never "Posted",
// so we don't imply a posting date we don't have); unavailable renders em dash.
function postedDisplay(role: RoleRow): string {
  const status = role.posted_status ?? "unavailable";
  if (status === "exact") {
    const rel = formatRelative(role.posted_at);
    return rel ? `Posted ${rel}` : "—";
  }
  if (status === "inferred_from_discovered_at") {
    const rel = formatRelative(role.discovered_at ?? role.posted_at);
    return rel ? `Discovered ${rel}` : "—";
  }
  return "—";
}

export function RoleTable({
  roles,
  emptyMessage,
  companyName,
  companyDomain,
}: RoleTableProps) {
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [drawer, setDrawer] = React.useState<{
    open: boolean;
    poc: ChampionPOC | null;
    role: RoleRow | null;
  }>({ open: false, poc: null, role: null });
  const [contactTarget, setContactTarget] =
    React.useState<FindContactTarget | null>(null);

  const openFindContact = React.useCallback(
    (role: RoleRow) => {
      setContactTarget({
        jobId: role.id,
        companyId: role.company_id,
        companyName: companyName ?? null,
        companyDomain: companyDomain ?? null,
        jobTitle: role.title,
        roleCategory: role.role_category ?? null,
        domainCategory: role.domain_category ?? null,
      });
    },
    [companyName, companyDomain]
  );

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
                  {(() => {
                    const comp = compensationDisplay(role);
                    if (!comp) return "—";
                    return (
                      <span>
                        {comp.text}
                        {comp.parsed && (
                          <span className="ml-1 rounded bg-neutral-100 px-1 text-[10px] uppercase tracking-wide text-neutral-500">
                            parsed
                          </span>
                        )}
                      </span>
                    );
                  })()}
                </dd>
                <dt className="text-xs uppercase tracking-wide text-neutral-400">
                  Posted
                </dt>
                <dd className="text-right text-neutral-500">
                  {postedDisplay(role)}
                </dd>
              </dl>

              <div className="mt-3 border-t border-neutral-100 pt-2 text-xs">
                <span className="uppercase tracking-wide text-neutral-400">
                  Contact path
                </span>{" "}
                <span className="font-medium text-neutral-600">
                  {contactPathLabel(role)}
                </span>
              </div>

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
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="min-h-[44px] flex-1"
                    onClick={() =>
                      setExpanded((cur) => (cur === role.id ? null : role.id))
                    }
                    aria-expanded={isOpen}
                  >
                    {isOpen ? "Hide details" : "Details"}
                  </Button>
                  <Button
                    variant="outline"
                    className="min-h-[44px] flex-1"
                    onClick={() => openFindContact(role)}
                  >
                    Find Contact
                  </Button>
                </div>
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
                      <div className="mt-1 text-xs">
                        <span className="uppercase tracking-wide text-neutral-400">
                          Contact path
                        </span>{" "}
                        <span className="text-neutral-600">
                          {contactPathLabel(role)}
                        </span>
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
                      {(() => {
                        const comp = compensationDisplay(role);
                        if (!comp) return "—";
                        return (
                          <span>
                            {comp.text}
                            {comp.parsed && (
                              <span className="ml-1 rounded bg-neutral-100 px-1 text-[10px] uppercase tracking-wide text-neutral-500">
                                parsed
                              </span>
                            )}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 align-top">
                      {ghostBadge(role.ghost_score)}
                    </td>
                    <td className="px-4 py-3 align-top text-neutral-500">
                      {postedDisplay(role)}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setExpanded((cur) =>
                              cur === role.id ? null : role.id
                            )
                          }
                          aria-expanded={isOpen}
                        >
                          {isOpen ? "Hide" : "Details"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openFindContact(role)}
                        >
                          Find Contact
                        </Button>
                      </div>
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

      <FindContactDrawer
        open={contactTarget !== null}
        onClose={() => setContactTarget(null)}
        target={contactTarget}
      />
    </>
  );
}

export default RoleTable;
