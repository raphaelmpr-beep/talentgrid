import { Input } from "@/components/ui/input";

export function SearchBar({
  value,
  onChange,
  detectedDomain,
  detectedRole,
}: {
  value: string;
  onChange: (value: string) => void;
  detectedDomain?: string;
  detectedRole?: string;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor="job-search" className="text-xs font-medium uppercase tracking-wide text-neutral-600">
        Search Jobs (supports smart parsing)
      </label>
      <Input
        id="job-search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Try: HR backend, drone engineer"
        aria-label="Search Jobs"
      />
      {(detectedDomain || detectedRole) && (
        <p className="text-xs text-neutral-500">
          Smart detect: {detectedDomain ?? "-"} {detectedRole ? `· ${detectedRole}` : ""}
        </p>
      )}
    </div>
  );
}
