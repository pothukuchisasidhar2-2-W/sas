import { useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../../api/client";
import { PageBody, PageHeader } from "../../components/AppShell";
import { DateStrip } from "../../components/DateStrip";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatTile,
} from "../../components/ui";
import { useAuth, useToken } from "../../lib/auth";
import { PERIOD_LABEL, formatLongDate, isoToday } from "../../lib/format";
import { useApiData } from "../../lib/useApiData";

export default function TeacherDashboard() {
  const { user } = useAuth();
  const token = useToken();
  const [date, setDate] = useState(isoToday());

  const sections = useApiData([token], () => api.teacherSections(token));
  const periods = useApiData([token, date], () => api.teacherSchedule(token, date));
  const department = useApiData([token], () => api.myDepartment(token));
  const analytics = useApiData([token], () => api.deptAnalytics(token));

  if (!user || user.role !== "teacher") return null;
  const teacher = user.profile;

  const mySections = sections.data ?? [];
  const dayPeriods = periods.data ?? [];
  const riskRows = analytics.data ?? [];
  const knownRiskRows = riskRows.filter((row) => row.atRiskCount !== null);
  const atRisk = knownRiskRows.reduce((total, row) => total + (row.atRiskCount ?? 0), 0);
  const riskIncomplete = knownRiskRows.length < riskRows.length;

  return (
    <PageBody>
      <PageHeader
        title={teacher.isHod ? "Department overview" : "Your day"}
        description={formatLongDate(date)}
        actions={
          <>
            <Badge tone={teacher.isHod ? "brand" : "neutral"}>
              {teacher.isHod ? "HOD" : "Teacher"}
            </Badge>
            {teacher.departmentName && <Badge tone="neutral">{teacher.departmentName}</Badge>}
          </>
        }
      />

      {!teacher.departmentId && (
        <div className="pb-5">
          <Alert
            tone="info"
            title="You are not in a department yet"
            action={
              <Link to="/teacher/department">
                <Button size="sm" variant="secondary">
                  Set it up
                </Button>
              </Link>
            }
          >
            Create a department to become its HOD, or join one with the code your HOD shared.
          </Alert>
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Periods today"
          value={periods.loading ? "…" : dayPeriods.length}
          hint={date === isoToday() ? "On today's grid" : "On this date"}
        />
        <StatTile
          label="Classes in scope"
          value={sections.loading ? "…" : mySections.length}
          hint={teacher.isHod ? "Whole department" : "Your assignments"}
        />
        <StatTile
          label="Students"
          value={
            sections.loading
              ? "…"
              : mySections.reduce((total, section) => total + section.strength, 0)
          }
          hint="Across those classes"
        />
        <StatTile
          label="Below threshold"
          value={analytics.loading ? "…" : riskIncomplete ? `${atRisk}+` : atRisk}
          hint={riskIncomplete ? "More marks needed for a complete count" : "Student–subject pairs"}
          tone={atRisk > 0 ? "text-absent" : "text-present"}
        />
      </div>

      <Card className="mb-5 p-4">
        <DateStrip selected={date} onSelect={setDate} />
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title={date === isoToday() ? "Your periods today" : `Periods on ${formatLongDate(date)}`}
            description={
              teacher.isHod
                ? "Every period your department runs on this day."
                : "Only the classes you are assigned to."
            }
            action={
              <Link
                to="/teacher/classes"
                className="text-xs font-medium text-brand hover:underline"
              >
                Open monitoring
              </Link>
            }
          />

          {periods.loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-muted">
              <Spinner />
              <span className="text-[13px]">Loading…</span>
            </div>
          ) : dayPeriods.length === 0 ? (
            <EmptyState
              title="No periods on this day"
              description="Weekends, holidays, or simply no assignments on this weekday."
            />
          ) : (
            <ul className="divide-y divide-line">
              {dayPeriods.map((slot) => (
                <li
                  key={slot.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
                >
                  <div className="flex min-w-0 items-start gap-4">
                    <div className="w-24 shrink-0">
                      <p className="text-[13px] font-medium tabular-nums text-ink">
                        {PERIOD_LABEL(slot.startTime, slot.endTime)}
                      </p>
                      <p className="mt-0.5 text-[11px] text-faint">{slot.room}</p>
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-ink">{slot.subjectId}</p>
                      <p className="mt-0.5 truncate text-[11px] text-muted">{slot.sectionId}</p>
                    </div>
                  </div>
                  <Link
                    to={`/teacher/classes?section=${encodeURIComponent(slot.sectionId)}&date=${date}&slot=${encodeURIComponent(slot.id)}`}
                  >
                    <Button size="sm" variant="secondary">
                      Attendance
                    </Button>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader title="Your classes" description="Everything you can mark attendance for." />
            {sections.loading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-muted">
                <Spinner />
              </div>
            ) : mySections.length === 0 ? (
              <EmptyState
                title="No classes assigned"
                description="Ask your HOD to add you to a section, or re-register with the class you manage."
              />
            ) : (
              <ul className="divide-y divide-line">
                {mySections.map((section) => (
                  <li
                    key={section.id}
                    className="flex items-center justify-between gap-3 px-5 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-ink">{section.id}</p>
                      <p className="mt-0.5 text-[11px] text-muted">{section.strength} students</p>
                    </div>
                    <Link
                      to={`/teacher/classes?section=${encodeURIComponent(section.id)}&date=${date}`}
                    >
                      <Button size="sm" variant="ghost">
                        View
                      </Button>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {department.data && (
            <Card>
              <CardHeader
                title="Department"
                description={department.data.name}
                action={
                  <Link
                    to="/teacher/department"
                    className="text-xs font-medium text-brand hover:underline"
                  >
                    Open
                  </Link>
                }
              />
              <CardBody>
                <dl className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-4 py-1.5">
                    <dt className="text-xs text-muted">Members</dt>
                    <dd className="text-[13px] font-medium text-ink">
                      {department.data.memberCount}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 py-1.5">
                    <dt className="text-xs text-muted">HOD</dt>
                    <dd className="text-[13px] font-medium text-ink">
                      {department.data.hodName}
                    </dd>
                  </div>
                </dl>
                {teacher.isHod && (
                  <p className="mt-3 text-xs leading-relaxed text-muted">
                    As HOD you can share the join code, review each member's access, and see the
                    department board.
                  </p>
                )}
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </PageBody>
  );
}
