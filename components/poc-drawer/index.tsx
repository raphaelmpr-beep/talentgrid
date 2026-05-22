"use client";

import * as React from "react";
import { Drawer, DrawerBody, DrawerFooter, DrawerHeader } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

export type ChampionPOC = {
  name: string;
  title?: string | null;
  email?: string | null;
  linkedin?: string | null;
  phone?: string | null;
  tags?: string[];
};

export type PocDrawerProps = {
  open: boolean;
  onClose: () => void;
  companyId?: string;
  roleTitle?: string;
  poc: ChampionPOC | null;
};

type SaveState = "idle" | "saving" | "saved" | "error";

export function PocDrawer({
  open,
  onClose,
  companyId,
  roleTitle,
  poc,
}: PocDrawerProps) {
  const [notes, setNotes] = React.useState("");
  const [state, setState] = React.useState<SaveState>("idle");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setNotes(roleTitle ? `Champion for: ${roleTitle}` : "");
      setState("idle");
      setError(null);
    }
  }, [open, roleTitle]);

  if (!poc) {
    return (
      <Drawer open={open} onClose={onClose}>
        <DrawerHeader>
          <div>
            <h2 className="text-base font-semibold">No champion identified</h2>
            <p className="text-sm text-neutral-500">
              We haven&apos;t identified a likely hiring manager for this role yet.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </DrawerHeader>
      </Drawer>
    );
  }

  async function handleSave() {
    if (!poc) return;
    setState("saving");
    setError(null);
    try {
      const res = await fetch("/api/rolodex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: companyId,
          name: poc.name,
          title: poc.title ?? undefined,
          email: poc.email ?? undefined,
          linkedin: poc.linkedin ?? undefined,
          phone: poc.phone ?? undefined,
          notes: notes.trim() || undefined,
          tags: poc.tags ?? [],
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          typeof body.error === "string" ? body.error : "Failed to save"
        );
      }
      setState("saved");
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "Failed to save");
    }
  }

  return (
    <Drawer open={open} onClose={onClose}>
      <DrawerHeader>
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Likely champion
          </div>
          <h2 className="mt-1 text-lg font-semibold">{poc.name}</h2>
          {poc.title && (
            <p className="text-sm text-neutral-500">{poc.title}</p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </DrawerHeader>

      <DrawerBody>
        <div className="space-y-4">
          <section className="rounded-lg border border-neutral-200 p-4">
            <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Contact
            </h3>
            <dl className="mt-3 space-y-2 text-sm">
              {poc.email && (
                <div className="flex items-baseline gap-2">
                  <dt className="w-20 shrink-0 text-neutral-500">Email</dt>
                  <dd>
                    <a
                      className="text-blue-600 hover:underline"
                      href={`mailto:${poc.email}`}
                    >
                      {poc.email}
                    </a>
                  </dd>
                </div>
              )}
              {poc.linkedin && (
                <div className="flex items-baseline gap-2">
                  <dt className="w-20 shrink-0 text-neutral-500">LinkedIn</dt>
                  <dd>
                    <a
                      className="text-blue-600 hover:underline"
                      href={poc.linkedin}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Profile
                    </a>
                  </dd>
                </div>
              )}
              {poc.phone && (
                <div className="flex items-baseline gap-2">
                  <dt className="w-20 shrink-0 text-neutral-500">Phone</dt>
                  <dd>{poc.phone}</dd>
                </div>
              )}
              {!poc.email && !poc.linkedin && !poc.phone && (
                <p className="text-sm text-neutral-500">
                  No direct contact info available.
                </p>
              )}
            </dl>
          </section>

          {poc.tags && poc.tags.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
                Tags
              </h3>
              <div className="flex flex-wrap gap-1">
                {poc.tags.map((t) => (
                  <Badge key={t} variant="outline">
                    {t}
                  </Badge>
                ))}
              </div>
            </section>
          )}

          <section>
            <label
              htmlFor="rolodex-notes"
              className="mb-2 block text-xs font-medium uppercase tracking-wide text-neutral-500"
            >
              Notes
            </label>
            <Input
              id="rolodex-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Why this contact is relevant…"
            />
          </section>

          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
        </div>
      </DrawerBody>

      <DrawerFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          disabled={state === "saving" || state === "saved"}
        >
          {state === "saved"
            ? "Saved to Rolodex"
            : state === "saving"
              ? "Saving…"
              : "Save to Rolodex"}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

export default PocDrawer;
