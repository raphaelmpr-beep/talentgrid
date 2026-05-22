"use client";

import * as React from "react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { formatRelative } from "@/lib/utils";

export type Signal = {
  id: string;
  kind: "role_added" | "role_removed" | "company_started_hiring" | "ghost_detected";
  title: string;
  detail?: string;
  href?: string;
  at: string;
};

const KIND_LABEL: Record<Signal["kind"], { label: string; variant: "default" | "secondary" | "success" | "warning" | "danger" }> = {
  role_added: { label: "New role", variant: "success" },
  role_removed: { label: "Removed", variant: "secondary" },
  company_started_hiring: { label: "Now hiring", variant: "default" },
  ghost_detected: { label: "Ghost", variant: "danger" },
};

const MAX_ITEMS = 50;

type RolePayload = {
  id: string;
  title: string;
  company_id: string;
  is_active?: boolean;
  ghost_score?: number;
  posted_at?: string | null;
  created_at?: string;
};

type CompanyPayload = {
  id: string;
  name: string;
  is_hiring?: boolean;
  updated_at?: string;
};

export type SignalFeedProps = {
  companyId?: string;
  initialSignals?: Signal[];
  className?: string;
};

export function SignalFeed({
  companyId,
  initialSignals = [],
  className,
}: SignalFeedProps) {
  const [signals, setSignals] = React.useState<Signal[]>(initialSignals);
  const [connected, setConnected] = React.useState(false);

  React.useEffect(() => {
    const supabase = createClient();

    const push = (s: Signal) => {
      setSignals((prev) => [s, ...prev].slice(0, MAX_ITEMS));
    };

    const rolesFilter = companyId ? `company_id=eq.${companyId}` : undefined;

    const channel = supabase
      .channel(`signals${companyId ? `-${companyId}` : ""}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "roles",
          ...(rolesFilter ? { filter: rolesFilter } : {}),
        },
        (payload) => {
          const r = payload.new as RolePayload;
          push({
            id: `role-add-${r.id}-${Date.now()}`,
            kind: "role_added",
            title: r.title,
            detail: "New role posted",
            href: `/companies/${r.company_id}`,
            at: r.created_at ?? new Date().toISOString(),
          });
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "roles",
          ...(rolesFilter ? { filter: rolesFilter } : {}),
        },
        (payload) => {
          const oldR = payload.old as Partial<RolePayload>;
          const newR = payload.new as RolePayload;
          if (oldR.is_active !== false && newR.is_active === false) {
            push({
              id: `role-rm-${newR.id}-${Date.now()}`,
              kind: "role_removed",
              title: newR.title,
              detail: "Role marked inactive",
              href: `/companies/${newR.company_id}`,
              at: new Date().toISOString(),
            });
          } else if (
            (oldR.ghost_score ?? 0) < 70 &&
            (newR.ghost_score ?? 0) >= 70
          ) {
            push({
              id: `ghost-${newR.id}-${Date.now()}`,
              kind: "ghost_detected",
              title: newR.title,
              detail: `Ghost score ${newR.ghost_score}`,
              href: `/companies/${newR.company_id}`,
              at: new Date().toISOString(),
            });
          }
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "companies",
          ...(companyId ? { filter: `id=eq.${companyId}` } : {}),
        },
        (payload) => {
          const oldC = payload.old as Partial<CompanyPayload>;
          const newC = payload.new as CompanyPayload;
          if (!oldC.is_hiring && newC.is_hiring) {
            push({
              id: `hiring-${newC.id}-${Date.now()}`,
              kind: "company_started_hiring",
              title: newC.name,
              detail: "Started hiring",
              href: `/companies/${newC.id}`,
              at: newC.updated_at ?? new Date().toISOString(),
            });
          }
        }
      )
      .subscribe((status) => {
        setConnected(status === "SUBSCRIBED");
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [companyId]);

  return (
    <div className={className}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-900">Signal feed</h3>
        <span
          className="inline-flex items-center gap-1.5 text-xs text-neutral-500"
          aria-live="polite"
        >
          <span
            className={
              connected
                ? "h-2 w-2 rounded-full bg-emerald-500"
                : "h-2 w-2 rounded-full bg-neutral-300"
            }
            aria-hidden
          />
          {connected ? "Live" : "Connecting…"}
        </span>
      </div>

      {signals.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-200 p-6 text-center text-xs text-neutral-500">
          Waiting for signals…
        </div>
      ) : (
        <ul className="space-y-2">
          {signals.map((s) => {
            const meta = KIND_LABEL[s.kind];
            const body = (
              <div className="flex items-start gap-3 rounded-md border border-neutral-200 bg-white p-3 transition-colors hover:bg-neutral-50">
                <Badge variant={meta.variant} className="mt-0.5 shrink-0">
                  {meta.label}
                </Badge>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-neutral-900">
                    {s.title}
                  </div>
                  {s.detail && (
                    <div className="truncate text-xs text-neutral-500">
                      {s.detail}
                    </div>
                  )}
                </div>
                <span className="shrink-0 text-xs text-neutral-400">
                  {formatRelative(s.at)}
                </span>
              </div>
            );
            return (
              <li key={s.id}>
                {s.href ? (
                  <a href={s.href} className="block">
                    {body}
                  </a>
                ) : (
                  body
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default SignalFeed;
