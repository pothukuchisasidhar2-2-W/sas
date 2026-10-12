import { Link } from "react-router-dom";

import { AppShell } from "../components/AppShell";
import type { NavItem } from "../components/AppShell";
import { Badge } from "../components/ui";
import { useAuth } from "../lib/auth";

const NAV: NavItem[] = [
  { to: "/teacher", label: "Overview", end: true },
  { to: "/teacher/classes", label: "Classes" },
  { to: "/teacher/timetable", label: "Timetable" },
  { to: "/teacher/department", label: "Department" },
];

export default function TeacherLayout() {
  const { user } = useAuth();
  if (!user || user.role !== "teacher") return null;
  const teacher = user.profile;

  const initials = teacher.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <AppShell
      nav={NAV}
      profile={
        <Link
          to="/teacher/department"
          className="block rounded-field transition-colors hover:bg-canvas"
        >
          <div className="px-2 py-1">
            <div className="flex items-center gap-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-soft text-[13px] font-semibold text-brand">
                {initials}
              </span>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-ink">{teacher.name}</p>
                <p className="truncate text-[11px] text-muted">
                  {teacher.departmentName ?? "No department yet"}
                </p>
              </div>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5 px-1">
              <Badge tone={teacher.isHod ? "brand" : "neutral"}>
                {teacher.isHod ? "HOD" : "Admin"}
              </Badge>
              <Badge tone="neutral">
                {teacher.assignments.length} class{teacher.assignments.length === 1 ? "" : "es"}
              </Badge>
            </div>
          </div>
        </Link>
      }
    />
  );
}
