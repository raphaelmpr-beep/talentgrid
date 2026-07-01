"use client";

// AgingRoleMarketValue — dashboard section for identifying expensive technical
// roles that have been open too long, and the total market value of those
// unresolved hiring needs.
//
// Purely additive — does not modify any existing component or data flow.

import * as React from "react";
import type { AgingRole, AgingRoleSummary } from "@/app/api/aging-roles/route";

// ── Job function options (mirrors lib/feeds/job-function.ts) ─────────────────
// Defined inline so this client component has no server-side import dependency.

const JOB_FUNCTION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "software_engineering", label: "Software Engineering" },
  { value: "data_science",         label: "Data Science" },
  { value: "ai_ml",                label: "AI / Machine Learning" },
  { value: "data_engineering",     label: "Data Engineering" },
  { value: "cybersecurity",        label: "Cybersecurity" },
  { value: "product",              label: "Product" },
  { value: "cloud_infrastructure", label: "Cloud / Infrastructure" },
  { value: "devops_sre",           label: "DevOps / SRE" },
];

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtShort(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000)     return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)         return `$${(n / 1_000).toFixed(0)}K`;
  return fmt(n);
}

function fmtDays(days: number | null): string {
  if (days == null) return "—";
  if (days >= 365) return `${(days / 365).toFixed(1)}y`;
  return `${days}d`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-4 flex flex-col gap-1 ${
        highlight
          ? "border-amber-200 bg-amber-50"
          : "border-neutral-200 bg-white"
      }`}
    >
      <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </span>
      <span className="text-xl font-semibold tabular-nums text-neutral-900">
        {value}
      </span>
      {sub && <span className="text-xs text-neutral-500">{sub}</span>}
    </div>
  );
}

function CompBadge({ disclosed }: { disclosed: boolean }) {
  return disclosed ? (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
      disclosed
    </span>
  ) : (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-neutral-100 text-neutral-500 border border-neutral-200">
      no comp
    </span>
  );
}

function FunctionCheckbox({
  option,
  checked,
  onChange,
}: {
  option: { value: string; label: string };
  checked: boolean;
  onChange: (v: string, checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-neutral-300 text-amber-600 focus:ring-amber-500"
        checked={checked}
        onChange={(e) => onChange(option.value, e.target.checked)}
      />
      <span className="text-sm text-neutral-700">{option.label}</span>
    </label>
  );
}

// ── Role table row ────────────────────────────────────────────────────────────

function RoleRow({ role }: { role: AgingRole }) {
  const compRange =
    role.comp_min_annual != null || role.comp_max_annual != null
      ? [
          role.comp_min_annual != null ? fmtShort(role.comp_min_annual) : null,
          role.comp_max_annual != null ? fmtShort(role.comp_max_annual) : null,
        ]
          .filter(Boolean)
          .join(" – ")
      : role.comp_text ?? null;

  return (
    <tr className="border-b border-neutral-100 hover:bg-neutral-50 transition-colors">
      <td className="py-2.5 pr-3 text-sm font-medium text-neutral-900 max-w-[180px]">
        <span className="block truncate" title={role.company_name}>
          {role.company_name}
        </span>
      </td>
      <td className="py-2.5 pr-3 text-sm text-neutral-700 max-w-[220px]">
        {role.url ? (
          <a
            href={role.url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline text-neutral-800 truncate block"
            title={role.title}
          >
            {role.title}
          </a>
        ) : (
          <span className="truncate block" title={role.title}>
            {role.title}
          </span>
        )}
      </td>
      <td className="py-2.5 pr-3 text-xs text-neutral-500 whitespace-nowrap">
        {role.job_function_label ?? <span className="text-neutral-400">Unclassified</span>}
      </td>
      <td className="py-2.5 pr-3 text-xs text-neutral-500 max-w-[120px]">
        <span className="truncate block" title={role.location ?? ""}>
          {role.location ?? "—"}
        </span>
      </td>
      <td className="py-2.5 pr-3 text-xs tabular-nums text-neutral-500 whitespace-nowrap">
        <span
          title={
            role.date_value
              ? `${role.date_field_used?.replace(/_/g, " ")}: ${new Date(role.date_value).toLocaleDateString()}`
              : "No date available"
          }
        >
          {role.days_open != null ? (
            <>
              <span
                className={
                  (role.days_open ?? 0) >= 180
                    ? "text-red-600 font-medium"
                    : (role.days_open ?? 0) >= 90
                    ? "text-amber-700"
                    : "text-neutral-500"
                }
              >
                {fmtDays(role.days_open)}
              </span>
              {role.date_value && (
                <span className="ml-1 text-neutral-400">
                  ({new Date(role.date_value).toLocaleDateString("en-US", { month: "short", day: "numeric" })})
                </span>
              )}
            </>
          ) : (
            "—"
          )}
        </span>
      </td>
      <td className="py-2.5 text-xs tabular-nums text-right whitespace-nowrap">
        {compRange ? (
          <span className="text-neutral-800">{compRange}</span>
        ) : (
          <span className="text-neutral-400">—</span>
        )}
        <span className="ml-2">
          <CompBadge disclosed={role.comp_disclosed} />
        </span>
      </td>
    </tr>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type ApiResponse = {
  summary: AgingRoleSummary;
  roles: AgingRole[];
  query: {
    min_days_open: number;
    functions: string[];
    cutoff_date: string;
  };
  total_matched_db: number;
  total_after_function_filter: number;
};

export function AgingRoleMarketValue() {
  // ── State ───────────────────────────────────────────────────────────────────
  const [minDays, setMinDays] = React.useState(90);
  const [daysInput, setDaysInput] = React.useState("90");
  const [selectedFunctions, setSelectedFunctions] = React.useState<Set<string>>(
    new Set(["software_engineering", "data_science"])
  );
  const [data, setData] = React.useState<ApiResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showAllRoles, setShowAllRoles] = React.useState(false);

  // ── Fetch ───────────────────────────────────────────────────────────────────
  const fetchData = React.useCallback(() => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({
      minDaysOpen: String(minDays),
      limit: "200",
      offset: "0",
    });
    if (selectedFunctions.size > 0) {
      params.set("functions", Array.from(selectedFunctions).join(","));
    }

    fetch(`/api/aging-roles?${params.toString()}`)
      .then((r) => {
        if (!r.ok) return r.json().then((b) => Promise.reject(b?.error ?? `HTTP ${r.status}`));
        return r.json() as Promise<ApiResponse>;
      })
      .then((d) => setData(d))
      .catch((e: unknown) =>
        setError(typeof e === "string" ? e : e instanceof Error ? e.message : "Failed to load")
      )
      .finally(() => setLoading(false));
  }, [minDays, selectedFunctions]);

  // Auto-fetch on first render.
  React.useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Handlers ────────────────────────────────────────────────────────────────
  function toggleFunction(value: string, checked: boolean) {
    setSelectedFunctions((prev) => {
      const next = new Set(prev);
      if (checked) next.add(value);
      else next.delete(value);
      return next;
    });
  }

  function commitDays() {
    const n = parseInt(daysInput, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= 3650) setMinDays(n);
    else setDaysInput(String(minDays));
  }

  // ── Derived ─────────────────────────────────────────────────────────────────
  const summary = data?.summary;
  const roles   = data?.roles ?? [];
  const displayedRoles = showAllRoles ? roles : roles.slice(0, 25);
  const selectedLabels = JOB_FUNCTION_OPTIONS.filter((o) =>
    selectedFunctions.has(o.value)
  ).map((o) => o.label);

  return (
    <section className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-neutral-900">
            Aging Role Market Value
          </h2>
          <p className="text-sm text-neutral-500 mt-0.5">
            Open roles past their shelf-life — total compensation value of
            unresolved hiring needs.
          </p>
        </div>
        <button
          type="button"
          onClick={fetchData}
          disabled={loading}
          className="inline-flex min-h-[40px] items-center rounded-md border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-700 shadow-sm hover:bg-neutral-50 disabled:opacity-50 transition-colors"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* Filters */}
      <div className="rounded-lg border border-neutral-200 bg-white p-4 space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Filters</p>

        {/* Days-open threshold */}
        <div className="flex items-center gap-3">
          <label htmlFor="min-days" className="text-sm text-neutral-700 shrink-0">
            Open longer than
          </label>
          <input
            id="min-days"
            type="number"
            min={1}
            max={3650}
            value={daysInput}
            onChange={(e) => setDaysInput(e.target.value)}
            onBlur={commitDays}
            onKeyDown={(e) => e.key === "Enter" && commitDays()}
            className="w-20 rounded-md border border-neutral-300 px-2 py-1.5 text-sm tabular-nums focus:border-amber-400 focus:ring-1 focus:ring-amber-400 focus:outline-none"
          />
          <span className="text-sm text-neutral-700">days</span>
        </div>

        {/* Function multi-select */}
        <div>
          <p className="text-xs text-neutral-500 mb-2">Job functions (select one or more)</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {JOB_FUNCTION_OPTIONS.map((opt) => (
              <FunctionCheckbox
                key={opt.value}
                option={opt}
                checked={selectedFunctions.has(opt.value)}
                onChange={toggleFunction}
              />
            ))}
          </div>
        </div>

        {/* Apply button */}
        <button
          type="button"
          onClick={fetchData}
          disabled={loading}
          className="inline-flex min-h-[40px] items-center rounded-md bg-amber-600 px-5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
        >
          {loading ? "Loading…" : "Apply filters"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && data && summary && summary.total_aging_roles === 0 && (
        <div className="rounded-md border border-neutral-200 bg-neutral-50 p-6 text-center text-sm text-neutral-600">
          No aging roles found for the current filters.{" "}
          {selectedFunctions.size === 0
            ? "Select at least one job function, or"
            : "Try"}{" "}
          reducing the days threshold or adding more functions.
        </div>
      )}

      {/* Summary cards */}
      {summary && summary.total_aging_roles > 0 && (
        <>
          {/* Context line */}
          {selectedLabels.length > 0 && (
            <p className="text-sm text-neutral-500">
              Showing{" "}
              <strong className="text-neutral-800">
                {selectedLabels.join(", ")}
              </strong>{" "}
              roles open {">"}
              {minDays} days
              {data?.query.cutoff_date
                ? ` (since ${new Date(data.query.cutoff_date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })})`
                : ""}
              .
            </p>
          )}

          {/* Macro stats */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard
              label="Aging Roles"
              value={summary.total_aging_roles.toLocaleString()}
              sub={`${summary.roles_with_compensation} with comp`}
              highlight
            />
            <StatCard
              label="Missing Comp"
              value={summary.roles_missing_compensation.toLocaleString()}
              sub={`${Math.round((summary.roles_missing_compensation / summary.total_aging_roles) * 100)}% undisclosed`}
            />
            <StatCard
              label="Total Min Value"
              value={fmtShort(summary.total_comp_min || null)}
              sub="sum of all min ranges"
            />
            <StatCard
              label="Total Max Value"
              value={fmtShort(summary.total_comp_max || null)}
              sub="sum of all max ranges"
            />
            <StatCard
              label="Total Midpoint"
              value={fmtShort(summary.total_comp_midpoint || null)}
              sub="market value estimate"
              highlight
            />
            <StatCard
              label="Avg Range"
              value={
                summary.avg_comp_min != null && summary.avg_comp_max != null
                  ? `${fmtShort(summary.avg_comp_min)} – ${fmtShort(summary.avg_comp_max)}`
                  : fmtShort(summary.avg_comp_midpoint)
              }
              sub="per role"
            />
          </div>

          {/* Top companies tables */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* By aging-role count */}
            <div className="rounded-lg border border-neutral-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-neutral-800 mb-3">
                Top Companies by Aging-Role Count
              </h3>
              {summary.top_companies_by_count.length === 0 ? (
                <p className="text-xs text-neutral-500">No data</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-100">
                      <th className="pb-1.5 text-left text-xs font-medium text-neutral-500">Company</th>
                      <th className="pb-1.5 text-right text-xs font-medium text-neutral-500">Aging</th>
                      <th className="pb-1.5 text-right text-xs font-medium text-neutral-500">w/ comp</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.top_companies_by_count.map((c) => (
                      <tr key={c.company_id} className="border-b border-neutral-50">
                        <td className="py-1.5 text-xs text-neutral-700 truncate max-w-[150px]">
                          {c.company_name}
                        </td>
                        <td className="py-1.5 text-right text-xs font-medium tabular-nums text-amber-700">
                          {c.aging_role_count}
                        </td>
                        <td className="py-1.5 text-right text-xs tabular-nums text-neutral-500">
                          {c.roles_with_comp}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* By compensation value */}
            <div className="rounded-lg border border-neutral-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-neutral-800 mb-3">
                Top Companies by Total Comp Value
              </h3>
              {summary.top_companies_by_comp.length === 0 ? (
                <p className="text-xs text-neutral-500">
                  No compensation data available for current filters.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-100">
                      <th className="pb-1.5 text-left text-xs font-medium text-neutral-500">Company</th>
                      <th className="pb-1.5 text-right text-xs font-medium text-neutral-500">Roles</th>
                      <th className="pb-1.5 text-right text-xs font-medium text-neutral-500">Total Midpoint</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.top_companies_by_comp.map((c) => (
                      <tr key={c.company_id} className="border-b border-neutral-50">
                        <td className="py-1.5 text-xs text-neutral-700 truncate max-w-[130px]">
                          {c.company_name}
                        </td>
                        <td className="py-1.5 text-right text-xs tabular-nums text-neutral-500">
                          {c.aging_role_count}
                        </td>
                        <td className="py-1.5 text-right text-xs font-medium tabular-nums text-emerald-700">
                          {fmtShort(c.total_comp_midpoint)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Role list */}
          <div className="rounded-lg border border-neutral-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-neutral-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-neutral-800">
                Aging Role List
                <span className="ml-2 text-xs font-normal text-neutral-500">
                  ({summary.total_aging_roles.toLocaleString()} total
                  {data && data.total_matched_db > summary.total_aging_roles
                    ? `, ${data.total_matched_db} in DB before function filter`
                    : ""}
                  )
                </span>
              </h3>
              {roles.length > 25 && (
                <button
                  type="button"
                  onClick={() => setShowAllRoles((v) => !v)}
                  className="text-xs text-amber-700 hover:underline"
                >
                  {showAllRoles ? "Show fewer" : `Show all ${roles.length}`}
                </button>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-sm">
                <thead className="bg-neutral-50 border-b border-neutral-100">
                  <tr>
                    <th className="py-2 pr-3 pl-4 text-left text-xs font-medium text-neutral-500">Company</th>
                    <th className="py-2 pr-3 text-left text-xs font-medium text-neutral-500">Title</th>
                    <th className="py-2 pr-3 text-left text-xs font-medium text-neutral-500">Function</th>
                    <th className="py-2 pr-3 text-left text-xs font-medium text-neutral-500">Location</th>
                    <th className="py-2 pr-3 text-left text-xs font-medium text-neutral-500">Days Open</th>
                    <th className="py-2 pr-4 text-right text-xs font-medium text-neutral-500">Compensation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-50">
                  {displayedRoles.map((role) => (
                    <RoleRow key={role.id} role={role} />
                  ))}
                </tbody>
              </table>
            </div>

            {!showAllRoles && roles.length > 25 && (
              <div className="px-4 py-3 border-t border-neutral-100 text-center">
                <button
                  type="button"
                  onClick={() => setShowAllRoles(true)}
                  className="text-xs text-amber-700 hover:underline"
                >
                  Show all {roles.length} roles
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
