import type { AttendanceStatus } from "../api/types";

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function parseIsoDate(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}

export function isoToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

export function addDaysIso(iso: string, days: number): string {
  const date = parseIsoDate(iso);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

export function formatDate(iso: string, opts: Intl.DateTimeFormatOptions = {}): string {
  return parseIsoDate(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", ...opts });
}

export function formatLongDate(iso: string): string {
  return parseIsoDate(iso).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** "Today", "Yesterday", or the weekday name — for compact date strips. */
export function relativeDayLabel(iso: string, today = isoToday()): string {
  if (iso === today) return "Today";
  if (iso === addDaysIso(today, -1)) return "Yesterday";
  return DAY_NAMES[parseIsoDate(iso).getDay()].slice(0, 3);
}

export function isSameIsoWeek(a: string, b: string): boolean {
  const start = (iso: string) => {
    const date = parseIsoDate(iso);
    const day = (date.getDay() + 6) % 7; // Monday-first
    date.setDate(date.getDate() - day);
    return date.getTime();
  };
  return start(a) === start(b);
}

export interface StatusMeta {
  label: string;
  /** Text colour class. */
  text: string;
  /** Background class. */
  bg: string;
  /** Solid dot colour for dense tables. */
  dot: string;
  /** Longer explanation used in legends and tooltips. */
  description: string;
}

/**
 * Status is never signalled by colour alone — every badge also carries its
 * label, and the dot is supplementary.
 */
export const STATUS_META: Record<AttendanceStatus, StatusMeta> = {
  present: {
    label: "Present",
    text: "text-present",
    bg: "bg-present-bg",
    dot: "bg-present",
    description: "Marked present, by face or manually.",
  },
  absent: {
    label: "Absent",
    text: "text-absent",
    bg: "bg-absent-bg",
    dot: "bg-absent",
    description: "The class was held and no attendance was recorded.",
  },
  late: {
    label: "Late",
    text: "text-late",
    bg: "bg-late-bg",
    dot: "bg-late",
    description: "Arrived after the period started. Counts as attended.",
  },
  excused: {
    label: "Excused",
    text: "text-excused",
    bg: "bg-excused-bg",
    dot: "bg-excused",
    description: "Authorised absence. Left out of the percentage on both sides.",
  },
  unmarked: {
    label: "Not marked",
    text: "text-pending",
    bg: "bg-pending-bg",
    dot: "bg-pending",
    description: "The period has not run yet, or no one marked it.",
  },
};

export const PERIOD_LABEL = (start: string, end: string) => `${start} – ${end}`;

/** Percentage tone: below the usual 75% college cut-off is a warning. */
export function percentageTone(percentage: number | null): {
  text: string;
  bg: string;
  bar: string;
} {
  if (percentage === null) return { text: "text-faint", bg: "bg-pending-bg", bar: "bg-line-strong" };
  if (percentage >= 85) return { text: "text-present", bg: "bg-present-bg", bar: "bg-present" };
  if (percentage >= 75) return { text: "text-late", bg: "bg-late-bg", bar: "bg-late" };
  return { text: "text-absent", bg: "bg-absent-bg", bar: "bg-absent" };
}

export function formatPercentage(percentage: number | null): string {
  if (percentage === null) return "—";
  return `${percentage.toFixed(1)}%`;
}
