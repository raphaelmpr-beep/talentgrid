"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type ToggleOption = { value: string; label: string };

export function ToggleGroup({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ToggleOption[];
  className?: string;
}) {
  return (
    <div
      role="group"
      className={cn(
        "inline-flex items-center rounded-md border border-neutral-200 bg-neutral-50 p-1",
        className
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded px-3 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-white text-neutral-900 shadow-sm"
                : "text-neutral-600 hover:text-neutral-900"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
