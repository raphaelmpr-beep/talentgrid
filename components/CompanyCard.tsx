import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatCompactNumber } from "@/lib/utils";
import type { CompanyResult } from "@/components/company-results/types";

export function CompanyCard({ company }: { company: CompanyResult }) {
  const topRoles = company.rolesSummary.slice(0, 3);

  return (
    <Card className="overflow-hidden">
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-neutral-900">{company.name}</h3>
            <p className="text-sm text-neutral-500">{company.location || "Location not listed"}</p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold tabular-nums text-neutral-900">
              {formatCompactNumber(company.jobCount)}
            </div>
            <p className="text-xs uppercase tracking-wide text-neutral-500">Open roles</p>
          </div>
        </div>

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

        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Top roles</p>
          {topRoles.length > 0 ? (
            topRoles.map((item) => (
              <p key={item.role} className="text-sm text-neutral-700">
                {item.role} ({item.count})
              </p>
            ))
          ) : (
            <p className="text-sm text-neutral-500">No role breakdown available.</p>
          )}
        </div>

        <div className="flex items-center justify-between pt-2">
          <p className="text-xs text-neutral-500">Full job data included for drill-down.</p>
          <Link
            href={`/companies/${company.id}`}
            className="inline-flex h-8 items-center justify-center rounded-md bg-neutral-900 px-3 text-sm font-medium text-white transition-colors hover:bg-neutral-800"
          >
            View Jobs
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
