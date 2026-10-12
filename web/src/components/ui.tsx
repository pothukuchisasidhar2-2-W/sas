/* ---------------------------------------------------------------------------
   Shared UI primitives.

   One file on purpose: a small, closed set of building blocks is what keeps a
   minimal interface from drifting. If a screen needs a button, a badge or a
   card, it uses these — nothing invents its own.
--------------------------------------------------------------------------- */

import { useEffect, type ReactNode } from "react";

import { STATUS_META } from "../lib/format";
import type { AttendanceStatus } from "../api/types";

export const cx = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(" ");

/* ------------------------------------------------------------------ button */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-brand text-white border border-brand hover:bg-brand-hover hover:border-brand-hover disabled:bg-brand/50 disabled:border-brand/40",
  secondary:
    "bg-surface text-ink border border-line-strong hover:bg-canvas disabled:text-faint",
  ghost: "bg-transparent text-muted border border-transparent hover:bg-canvas hover:text-ink",
  danger: "bg-surface text-absent border border-line-strong hover:bg-absent-bg",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center rounded-field font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-80",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
    >
      {loading && <Spinner className="size-3.5" />}
      {children}
    </button>
  );
}

/* ----------------------------------------------------------------- spinner */

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("animate-spin", className ?? "size-4")} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------- form fields */

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink">
        {label}
        {required && <span className="text-absent"> *</span>}
      </span>
      {children}
      {error ? (
        <span className="text-xs text-absent">{error}</span>
      ) : hint ? (
        <span className="text-xs text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

const CONTROL =
  "w-full rounded-field border bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint " +
  "border-line-strong transition-colors disabled:bg-canvas disabled:text-muted";

export function Input({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(CONTROL, "h-10", className)} />;
}

export function Select({
  className,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(CONTROL, "h-10 pr-8 appearance-none bg-no-repeat", className)}>
      {children}
    </select>
  );
}

export function Textarea({
  className,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(CONTROL, "min-h-24 leading-relaxed", className)} />;
}

/* -------------------------------------------------------------------- card */

export function Card({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cx("rounded-card border border-line bg-surface", className)}>
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cx(
        "flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </div>
      {action}
    </header>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("px-5 py-4", className)}>{children}</div>;
}

/* ------------------------------------------------------------------- badge */

export function Badge({
  children,
  className,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  tone?: "neutral" | "brand" | "present" | "absent" | "late";
}) {
  const tones: Record<string, string> = {
    neutral: "bg-pending-bg text-pending",
    brand: "bg-brand-soft text-brand",
    present: "bg-present-bg text-present",
    absent: "bg-absent-bg text-absent",
    late: "bg-late-bg text-late",
  };
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Attendance status pill. The label is always rendered, so meaning never
 * depends on colour alone.
 */
export function StatusBadge({
  status,
  className,
}: {
  status: AttendanceStatus;
  className?: string;
}) {
  const meta = STATUS_META[status];
  return (
    <span
      title={meta.description}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
        meta.bg,
        meta.text,
        className,
      )}
    >
      <span className={cx("size-1.5 rounded-full", meta.dot)} aria-hidden />
      {meta.label}
    </span>
  );
}

/* ---------------------------------------------------------------- progress */

export function ProgressBar({
  value,
  barClassName,
  className,
  label,
}: {
  value: number | null;
  barClassName?: string;
  className?: string;
  label?: string;
}) {
  const clamped = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div
      className={cx("h-1.5 w-full overflow-hidden rounded-full bg-pending-bg", className)}
      role="img"
      aria-label={label ?? `${clamped.toFixed(0)} percent`}
    >
      <div
        className={cx("h-full rounded-full transition-[width] duration-300", barClassName ?? "bg-brand")}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------- alert */

export function Alert({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "error" | "success" | "warning";
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const tones = {
    info: "border-line bg-canvas text-ink",
    error: "border-absent/25 bg-absent-bg text-absent",
    success: "border-present/25 bg-present-bg text-present",
    warning: "border-late/25 bg-late-bg text-late",
  };
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cx("rounded-field border px-3.5 py-3 text-[13px]", tones[tone])}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          {title && <p className="font-medium">{title}</p>}
          {children && <div className={cx(title && "mt-0.5", "opacity-90")}>{children}</div>}
        </div>
        {action}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- empty state */

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-center gap-2 px-6 py-12 text-center", className)}>
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="max-w-sm text-xs text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ tables */

export function Th({
  children,
  className,
  align = "left",
}: {
  children?: ReactNode;
  className?: string;
  align?: "left" | "right" | "center";
}) {
  return (
    <th
      scope="col"
      className={cx(
        "whitespace-nowrap border-b border-line px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-muted",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  align = "left",
}: {
  children?: ReactNode;
  className?: string;
  align?: "left" | "right" | "center";
}) {
  return (
    <td
      className={cx(
        "border-b border-line px-4 py-2.5 text-[13px] text-ink last:border-0",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </td>
  );
}

export function TableWrap({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("w-full overflow-x-auto", className)}>
      <table className="w-full border-collapse">{children}</table>
    </div>
  );
}

/* ------------------------------------------------------------------- modal */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/25 p-4 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx("w-full rounded-card border border-line bg-surface shadow-xl", width)}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            Close
          </Button>
        </header>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</footer>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- tabs */

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 rounded-field border border-line bg-surface p-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          aria-pressed={active === tab.id}
          className={cx(
            "inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[13px] font-medium transition-colors",
            active === tab.id ? "bg-brand-soft text-brand" : "text-muted hover:bg-canvas hover:text-ink",
          )}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="rounded-full bg-canvas px-1.5 text-[11px] text-muted">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- misc */

export function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={cx("mt-1 text-2xl font-semibold tabular-nums", tone ?? "text-ink")}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cx("border-0 border-t border-line", className)} />;
}

export function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-right text-[13px] font-medium text-ink">{value}</dd>
    </div>
  );
}
