import { Button } from "@/components/ui/button";

export type DomainOption = {
  value: string;
  label: string;
};

export function DomainFilter({
  options,
  value,
  onChange,
}: {
  options: DomainOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-600">Domains</p>
      <div className="scrollbar-hide -mx-1 flex gap-2 overflow-x-auto px-1 py-1">
        {options.map((option) => (
          <Button
            key={option.value}
            type="button"
            size="sm"
            variant={value === option.value ? "default" : "outline"}
            className="min-h-[40px] whitespace-nowrap rounded-full px-4 py-2 active:scale-95"
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
