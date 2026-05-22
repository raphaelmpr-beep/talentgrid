"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export function Drawer({
  open,
  onClose,
  children,
  side = "right",
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  side?: "right" | "left";
  className?: string;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div
        aria-hidden
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        className={cn(
          "absolute top-0 h-full w-full max-w-md bg-white shadow-xl",
          "flex flex-col overflow-hidden",
          side === "right" ? "right-0" : "left-0",
          className
        )}
      >
        {children}
      </aside>
    </div>
  );
}

export function DrawerHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 border-b border-neutral-200 p-4",
        className
      )}
      {...props}
    />
  );
}

export function DrawerBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex-1 overflow-y-auto p-4", className)} {...props} />
  );
}

export function DrawerFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2 border-t border-neutral-200 p-4",
        className
      )}
      {...props}
    />
  );
}
