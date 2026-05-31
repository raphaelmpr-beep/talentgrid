"use client";

import * as React from "react";
import {
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  getContactPath,
  getRecruiterSearchLinks,
  type ContactPath,
} from "@/lib/recruiter-intel/contact-path";

// Context passed in from a job card / role row. Everything is optional so the
// drawer degrades gracefully for sparse rows; the contact path still routes
// from whatever signal is available (title, then category hints).
export type FindContactTarget = {
  jobId?: string | null;
  companyId?: string | null;
  companyName?: string | null;
  companyDomain?: string | null;
  jobTitle?: string | null;
  roleCategory?: string | null;
  domainCategory?: string | null;
  department?: string | null;
};

export type FindContactDrawerProps = {
  open: boolean;
  onClose: () => void;
  target: FindContactTarget | null;
};

type SaveState = "idle" | "saving" | "saved" | "error";

const CONFIDENCE_VARIANT: Record<
  ContactPath["confidence_level"],
  "success" | "warning" | "secondary"
> = {
  high: "success",
  medium: "warning",
  low: "secondary",
};

export function FindContactDrawer({
  open,
  onClose,
  target,
}: FindContactDrawerProps) {
  const [fullName, setFullName] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [linkedin, setLinkedin] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [state, setState] = React.useState<SaveState>("idle");
  const [error, setError] = React.useState<string | null>(null);

  const contactPath = React.useMemo<ContactPath | null>(() => {
    if (!target) return null;
    return getContactPath({
      title: target.jobTitle,
      role_category: target.roleCategory,
      domain_category: target.domainCategory,
      department: target.department,
      company_name: target.companyName,
    });
  }, [target]);

  const searchLinks = React.useMemo(() => {
    if (!target || !contactPath) return [];
    return getRecruiterSearchLinks(
      {
        company_name: target.companyName,
        company_domain: target.companyDomain,
        job_title: target.jobTitle,
        role_category: target.roleCategory,
      },
      contactPath
    );
  }, [target, contactPath]);

  // Reset the form each time the drawer is (re)opened for a target.
  React.useEffect(() => {
    if (!open) return;
    setFullName("");
    setTitle(contactPath?.likely_contact_types[0] ?? "");
    setLinkedin("");
    setEmail("");
    setPhone("");
    setNotes(
      target?.jobTitle ? `Likely contact for: ${target.jobTitle}` : ""
    );
    setState("idle");
    setError(null);
  }, [open, target, contactPath]);

  if (!target || !contactPath) {
    return (
      <Drawer open={open} onClose={onClose}>
        <DrawerHeader>
          <h2 className="text-base font-semibold">Find Contact</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </DrawerHeader>
      </Drawer>
    );
  }

  const canSave = fullName.trim().length > 0 && title.trim().length > 0;

  function resetForAnother() {
    setFullName("");
    setTitle(contactPath?.likely_contact_types[0] ?? "");
    setLinkedin("");
    setEmail("");
    setPhone("");
    setNotes(target?.jobTitle ? `Likely contact for: ${target.jobTitle}` : "");
    setState("idle");
    setError(null);
  }

  async function handleSave() {
    if (!target || !contactPath || !canSave) return;
    if (state === "saved") {
      resetForAnother();
      return;
    }
    setState("saving");
    setError(null);
    try {
      const isUuid = (v: string | null | undefined) =>
        typeof v === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          v
        );
      const res = await fetch("/api/rolodex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: isUuid(target.companyId) ? target.companyId : undefined,
          name: fullName.trim(),
          title: title.trim(),
          linkedin: linkedin.trim() || undefined,
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
          notes: notes.trim() || undefined,
          companyName: target.companyName ?? undefined,
          jobOpeningId: isUuid(target.jobId) ? target.jobId : undefined,
          jobTitle: target.jobTitle ?? undefined,
          contactPathLabel: contactPath.contact_path_label,
          confidenceLevel: contactPath.confidence_level,
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
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Find Contact
          </div>
          <h2 className="mt-1 truncate text-lg font-semibold">
            {target.companyName ?? "Company"}
          </h2>
          {target.jobTitle && (
            <p className="truncate text-sm text-neutral-500">
              {target.jobTitle}
            </p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </DrawerHeader>

      <DrawerBody>
        <div className="space-y-5">
          <section className="rounded-lg border border-neutral-200 p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                Likely contact path
              </h3>
              <Badge variant={CONFIDENCE_VARIANT[contactPath.confidence_level]}>
                {contactPath.confidence_level} confidence
              </Badge>
            </div>
            <div className="mt-2 text-sm font-semibold text-neutral-900">
              {contactPath.contact_path_label}
            </div>
            <dl className="mt-2 space-y-1 text-sm text-neutral-600">
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 text-neutral-400">Department</dt>
                <dd>{contactPath.likely_department}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 text-neutral-400">Contact types</dt>
                <dd>{contactPath.likely_contact_types.join(", ")}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-neutral-400">
              Routing is a suggestion, not a verified person. Confirm any contact
              before reaching out.
            </p>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
              Manual search
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {searchLinks.map((link) => (
                <a
                  key={link.key}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex min-h-[40px] items-center justify-center rounded-md border border-neutral-300 bg-white px-3 text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-50"
                >
                  {link.label} ↗
                </a>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-neutral-200 p-4">
            <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Save to Rolodex
            </h3>
            <div className="mt-3 space-y-3">
              <Field label="Full name" required>
                <Input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Jane Recruiter"
                />
              </Field>
              <Field label="Title" required>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={contactPath.likely_contact_types[0]}
                />
              </Field>
              <Field label="LinkedIn URL">
                <Input
                  value={linkedin}
                  onChange={(e) => setLinkedin(e.target.value)}
                  placeholder="https://linkedin.com/in/…"
                />
              </Field>
              <Field label="Email">
                <Input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                />
              </Field>
              <Field label="Phone">
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Optional"
                />
              </Field>
              <Field label="Notes">
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Why this contact is relevant…"
                />
              </Field>
            </div>

            {error && (
              <p className="mt-3 text-sm text-red-600" role="alert">
                {error}
              </p>
            )}

            {state === "saved" && (
              <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">
                <span>Saved to Rolodex.</span>
                <a href="/rolodex" className="font-medium underline">
                  View in Rolodex ↗
                </a>
              </div>
            )}
          </section>
        </div>
      </DrawerBody>

      <DrawerFooter>
        <Button variant="outline" onClick={onClose}>
          {state === "saved" ? "Done" : "Cancel"}
        </Button>
        <Button
          onClick={handleSave}
          disabled={!canSave || state === "saving"}
        >
          {state === "saving"
            ? "Saving…"
            : state === "saved"
              ? "Save another"
              : "Save to Rolodex"}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-neutral-600">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      {children}
    </label>
  );
}

export default FindContactDrawer;
