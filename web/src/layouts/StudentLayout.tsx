import { Link } from "react-router-dom";

import { AppShell } from "../components/AppShell";
import type { NavItem } from "../components/AppShell";
import { Badge } from "../components/ui";
import { useAuth } from "../lib/auth";

const NAV: NavItem[] = [
  { to: "/student", label: "Dashboard", end: true },
  { to: "/student/attendance", label: "Attendance" },
  { to: "/student/timetable", label: "Timetable" },
  { to: "/student/profile", label: "Profile" },
];

export default function StudentLayout() {
  const { user } = useAuth();
  if (!user || user.role !== "student") return null;
  const student = user.profile;

  return (
    <AppShell
      nav={NAV}
      profile={
        <Link to="/student/profile" className="block rounded-field transition-colors hover:bg-canvas">
          <div className="px-2 py-1">
            <div className="flex items-center gap-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-soft text-[13px] font-semibold text-brand">
                {student.name
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((part) => part[0]?.toUpperCase() ?? "")
                  .join("")}
              </span>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-ink">{student.name}</p>
                <p className="truncate text-[11px] text-muted">Roll {student.studentId}</p>
              </div>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5 px-1">
              <Badge tone="brand">
                {student.branch} · Year {student.year} · Sec {student.section}
              </Badge>
              {!student.faceEnrolled && <Badge tone="late">Face not enrolled</Badge>}
            </div>
          </div>
        </Link>
      }
    />
  );
}
