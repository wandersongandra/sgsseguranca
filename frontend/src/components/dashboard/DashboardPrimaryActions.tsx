"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";

export interface DashboardPrimaryActionItem {
  label: string;
  href: string;
  Icon: LucideIcon;
}

export interface DashboardPrimaryActionsProps {
  items: DashboardPrimaryActionItem[];
}

export function DashboardPrimaryActions({
  items,
}: DashboardPrimaryActionsProps) {
  return (
    <section
      aria-label="Ações principais do dashboard"
      className="ds-dashboard-actions-strip"
    >
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--ds-color-text-secondary)]">
          Atalhos
        </p>
        <h2 className="text-sm font-bold text-[var(--title)]">
          Ações principais
        </h2>
      </div>

      <div className="ds-dashboard-actions-list">
        {items.map(({ label, href, Icon }) => (
          <Link
            key={href}
            href={href}
            aria-label={label}
            className="ds-dashboard-action-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-color-action-primary)] focus-visible:ring-offset-2"
          >
            <span className="ds-dashboard-action-link__icon" aria-hidden="true">
              <Icon className="h-4 w-4" />
            </span>
            <span className="truncate text-[12px] font-semibold text-[var(--ds-color-text-primary)]">
              {label}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
