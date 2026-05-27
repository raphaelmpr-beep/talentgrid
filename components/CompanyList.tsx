import { CompanyCard } from "@/components/CompanyCard";
import type { CompanyResult } from "@/components/company-results/types";

export function CompanyList({ companies }: { companies: CompanyResult[] }) {
  if (companies.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 sm:p-10">
        No companies match your filters.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {companies.map((company) => (
        <CompanyCard key={company.id} company={company} />
      ))}
    </div>
  );
}
