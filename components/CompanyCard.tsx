import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatCompactNumber, formatRelative } from "@/lib/utils";
import type { CompanyResult } from "@/components/company-results/types";

export function CompanyCard({
  company,
  filtersActive = false,
}: {
  company: CompanyResult;
  filtersActive?: boolean;
}) {
  const topRoles = (company.top_roles ?? company.rolesSummary).slice(0, 3);
  const matchingCount = company.active_openings_matching_filters ?? company.jobCount;
  const totalCount = Math.max(
    company.active_openings_total ?? company.jobCount,
    matchingCount
  );
  const revenueBand = company.revenue_band ?? company.revenueCategory;
  const latestSeen = formatRelative(company.latest_job_seen_at);
  // Show the matching (filtered) count as a secondary metric only when filters
  // are actually narrowing the set — i.e. there are active filters and the
  // matching count differs from the total company inventory.
  const showMatching = filtersActive && matchingCount !== totalCount;

  const diag = company.count_diagnostics;
  // The count-status indication shown on the card so a 0/low/capped count reads
  // as explained rather than broken. Driven by the backend count_display_mode.
  const countNote = (() => {
    if (!diag) return null;
    switch (diag.count_display_mode) {
      case "exact_source_total":
        return {
          tone: "ok" as const,
          text: `Total openings: ${formatCompactNumber(diag.total_source_openings ?? totalCount)} (source exact)`,
        };
      case "filtered_matching_openings": {
        const hidden = diag.filtered_out_openings_count ?? 0;
        return {
          tone: "info" as const,
          text: `Matching this filter: ${formatCompactNumber(diag.matching_openings_count)} · ${formatCompactNumber(hidden)} filtered out by role/domain filters`,
        };
      }
      case "validation_pending":
        return {
          tone: "warn" as const,
          text: "Validation pending — source count not exact yet",
        };
      case "non_exact_sample_withheld":
        return {
          tone: "warn" as const,
          text: "Source sample not exact — count withheld pending validation",
        };
      case "source_blocked":
        return {
          tone: "warn" as const,
          text:
            diag.source_status === "captcha_or_bot_challenge"
              ? "Source blocked (captcha/bot challenge)"
              : "Source blocked or not mapped — count may be stale",
        };
      case "deduped_role_rows":
      default:
        return null;
    }
  })();
  const noteToneClass =
    countNote?.tone === "ok"
      ? "text-emerald-700"
      : countNote?.tone === "warn"
        ? "text-amber-700"
        : "text-neutral-600";

  return (
    <Card className="h-full overflow-hidden border-neutral-200">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="break-words text-lg font-semibold text-neutral-900">{company.name}</h3>
            <p className="text-sm text-neutral-500">Location: {company.location || "Location not available"}</p>
            <p className="text-sm font-medium text-emerald-700">{revenueBand}</p>
            {latestSeen && (
              <p className="text-xs text-neutral-400">Latest job seen {latestSeen}</p>
            )}
          </div>
          <div className="shrink-0 text-right">
            <div className="text-2xl font-semibold tabular-nums text-neutral-900">
              {formatCompactNumber(totalCount)}
            </div>
            <p className="text-xs uppercase tracking-wide text-neutral-500">Total openings</p>
            {showMatching && (
              <p className="mt-0.5 text-xs font-medium text-emerald-700 tabular-nums">
                {formatCompactNumber(matchingCount)} matching filters
              </p>
            )}
          </div>
        </div>

        {countNote && (
          <p className={`text-xs font-medium ${noteToneClass}`}>{countNote.text}</p>
        )}

        <div className="flex flex-wrap gap-2">
          {company.domains.length > 0 ? (
            company.domains.map((domain) => (
              <Badge key={domain} variant="secondary">
                {domain}
              </Badge>
            ))
          ) : (
            <Badge variant="outline">General</Badge>
          )}
        </div>

        <div className="space-y-1 min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Top roles</p>
          {topRoles.length > 0 ? (
            topRoles.map((item) => (
              <p key={item.role} className="break-words text-sm text-neutral-700">
                {item.role} ({item.count})
              </p>
            ))
          ) : (
            <p className="text-sm text-neutral-500">No role breakdown available.</p>
          )}
        </div>

        <div className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-700">
          <p>
            Primary: {company.primaryCount ?? company.jobCount} | JobSpy: +{company.jobSpyCount ?? 0}
          </p>
          <p className="font-medium">
            {company.source_discrepancy
              ? "Source discrepancy flagged"
              : company.confidence === "enhanced"
                ? "Enhanced results"
                : company.confidence === "low"
                  ? "Low confidence"
                  : "Confirmed results"}
          </p>
          {typeof company.indeedEstimate === "number" && (
            <p>Indeed estimate: {company.indeedEstimate}</p>
          )}
        </div>

        <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-neutral-500">Full job data included for drill-down.</p>
          <Link
            href={`/companies/${company.id}`}
            className="inline-flex min-h-[40px] items-center justify-center rounded-md bg-neutral-900 px-3 text-sm font-medium text-white transition-colors hover:bg-neutral-800"
          >
            View Jobs
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
