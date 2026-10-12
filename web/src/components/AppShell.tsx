import type { ReactNode } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";

import { USING_MOCK } from "../api/client";
import { useAuth } from "../lib/auth";
import { Button, cx } from "./ui";

export interface NavItem {
  to: string;
  label: string;
  /** Highlight only on an exact match (for the dashboard root). */
  end?: boolean;
}

/* ------------------------------------------------------------------- brand */

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="grid size-7 place-items-center rounded-[7px] bg-brand text-[13px] font-semibold text-white">
        S
      </span>
      {!compact && <span className="text-sm font-semibold tracking-tight text-ink">Smart Attendance</span>}
    </span>
  );
}

/* ----------------------------------------------------------------- sidebar */

function NavList({ nav, onNavigate }: { nav: NavItem[]; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5">
      {nav.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cx(
              "rounded-field px-3 py-2 text-[13px] font-medium transition-colors",
              isActive ? "bg-brand-soft text-brand" : "text-muted hover:bg-canvas hover:text-ink",
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function AppShell({ nav, profile }: { nav: NavItem[]; profile: ReactNode }) {
  const { logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <div className="px-5 py-4">
          <Wordmark />
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-4">
          <NavList nav={nav} />
        </div>
        <div className="border-t border-line p-3">
          {profile}
          <Button variant="ghost" size="sm" className="mt-2 w-full justify-start" onClick={handleLogout}>
            Sign out
          </Button>
          {USING_MOCK && (
            <p className="px-3 pt-2 text-[11px] leading-snug text-faint">
              Demo data — nothing here is persisted to a server.
            </p>
          )}
        </div>
      </aside>

      {/* Mobile bar */}
      <div className="sticky top-0 z-30 border-b border-line bg-surface lg:hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <Wordmark />
          <Button variant="secondary" size="sm" onClick={handleLogout}>
            Sign out
          </Button>
        </div>
        <div className="flex gap-1 overflow-x-auto px-3 pb-2">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cx(
                  "whitespace-nowrap rounded-field px-3 py-1.5 text-[13px] font-medium",
                  isActive ? "bg-brand-soft text-brand" : "text-muted",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      </div>

      <main className="min-w-0 flex-1">
        <Outlet context={{ handleLogout }} />
      </main>
    </div>
  );
}

/* -------------------------------------------------------------- page header */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 pb-5">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function PageBody({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-8">{children}</div>;
}

/* ------------------------------------------------------------ profile block */

export function ProfileBlock({
  name,
  subtitle,
  meta,
  badge,
}: {
  name: string;
  subtitle: string;
  meta?: ReactNode;
  badge?: ReactNode;
}) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="px-2 py-1">
      <div className="flex items-center gap-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-soft text-[13px] font-semibold text-brand">
          {initials}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-ink">{name}</p>
          <p className="truncate text-[11px] text-muted">{subtitle}</p>
        </div>
      </div>
      {(badge || meta) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 px-1">
          {badge}
          {meta}
        </div>
      )}
    </div>
  );
}
