"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

export function CompanyFavoriteButton({ companyId }: { companyId: string }) {
  const [state, setState] = React.useState<"idle" | "saving" | "saved" | "error">(
    "idle"
  );
  const [error, setError] = React.useState<string | null>(null);

  async function save() {
    setState("saving");
    setError(null);
    try {
      const res = await fetch("/api/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId }),
      });
      if (!res.ok && res.status !== 409) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          typeof body.error === "string" ? body.error : "Failed to save"
        );
      }
      setState("saved");
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "Failed");
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant={state === "saved" ? "secondary" : "default"}
        onClick={save}
        disabled={state === "saving" || state === "saved"}
      >
        {state === "saved" ? "★ Saved" : state === "saving" ? "Saving…" : "★ Favorite"}
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
