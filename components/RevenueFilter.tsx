import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type RevenueOption = {
  value: string;
  label: string;
};

export function RevenueFilter({
  options,
  value,
  onChange,
}: {
  options: RevenueOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-600">Revenue</p>
      <div className="scrollbar-hide -mx-1 flex gap-2 overflow-x-auto px-1 py-1">
        {options.map((option) => (
          <Button
            key={option.value}
            type="button"
            size="sm"
            variant={value === option.value ? "default" : "outline"}
            aria-pressed={value === option.value}
            className={cn(
              "min-h-[40px] whitespace-nowrap rounded-full px-4 py-2 active:scale-95",
              value === option.value &&
                "font-semibold ring-2 ring-neutral-900 ring-offset-1"
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
