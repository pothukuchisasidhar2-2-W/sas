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
  ProgressBar,
  Spinner,
  StatTile,
  StatusBadge,
} from "../../components/ui";
import { useAuth, useToken } from "../../lib/auth";
import {
  PERIOD_LABEL,
  formatLongDate,
  formatPercentage,
  isoToday,
  percentageTone,
} from "../../lib/format";
import { useApiData } from "../../lib/useApiData";

/** The 75% line most colleges use to decide exam eligibility. */
const ELIGIBILITY = 75;

export default function StudentDashboard() {
  const { user } = useAuth();
  const token = useToken();
  const [date, setDate] = useState(isoToday());

  const summary = useApiData([token], () => api.studentSummary(token));
  const schedule = useApiData([token, date], () => api.studentSchedule(token, date));

  if (!user || user.role !== "student") return null;
  const student = user.profile;

  const entries = schedule.data ?? [];
  const held = entries.filter((entry) => entry.status !== "unmarked");
  const attended = held.filter((entry) => entry.status === "present" || entry.status === "late");

  const subjects = summary.data ?? [];
  const totals = subjects.reduce(
    (accumulator, subject) => {
      const counted = subject.presentCount + subject.lateCount;
      const denominator = subject.heldCount - subject.excusedCount;
      accumulator.attended += counted;
      accumulator.held += denominator;
      return accumulator;
    },
    { attended: 0, held: 0 },
  );
  const overall = totals.held > 0 ? (totals.attended / totals.held) * 100 : null;
  const overallTone = percentageTone(overall);
  const belowEligibility = subjects.filter(
    (subject) => subject.percentage !== null && subject.percentage < ELIGIBILITY,
  );

  return (
    <PageBody>
      <PageHeader
        title={`Hello, ${student.name.split(" ")[0]}`}
        description={formatLongDate(date)}
        actions={
          <>
            <Badge tone="brand">
              {student.branch} · Year {student.year} · Sec {student.section}
            </Badge>
            {!student.faceEnrolled && (
              <Link to="/student/enroll">
                <Button size="sm">Enrol your face</Button>
              </Link>
            )}
          </>
        }
      />

      {!student.faceEnrolled && (
        <div className="pb-5">
          <Alert
            tone="warning"
            title="Your face is not enrolled yet"
            action={
              <Link to="/student/enroll">
                <Button size="sm" variant="secondary">
                  Enrol now
                </Button>
              </Link>
            }
          >
            The camera cannot mark you present until you capture one photo.
          </Alert>
        </div>
      )}

      {/* Day picker sits above everything, as the entry point to any date. */}
      <Card className="mb-5 p-4">
        <DateStrip selected={date} onSelect={setDate} />
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* ------------------------------------------------------------ day */}
        <Card>
          <CardHeader
            title={date === isoToday() ? "Today's classes" : formatLongDate(date)}
            description={
              schedule.loading
                ? "Loading…"
                : held.length > 0
                  ? `${attended.length} of ${held.length} held periods attended`
                  : "No periods have been marked for this date."
            }
            action={
              <Link to="/student/attendance" className="text-xs font-medium text-brand hover:underline">
                Full history
              </Link>
            }
          />

          {schedule.loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-muted">
              <Spinner />
              <span className="text-[13px]">Loading the schedule…</span>
            </div>
          ) : schedule.error ? (
            <CardBody>
              <Alert tone="error">{schedule.error}</Alert>
            </CardBody>
          ) : entries.length === 0 ? (
            <EmptyState
              title="No classes on this day"
              description="Sundays and holidays have no periods. Pick another day above."
            />
          ) : (
            <ul className="divide-y divide-line">
              {entries.map((entry) => (
                <li
                  key={entry.slot.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
                >
                  <div className="flex min-w-0 items-start gap-4">
                    <div className="w-24 shrink-0">
                      <p className="text-[13px] font-medium tabular-nums text-ink">
                        {PERIOD_LABEL(entry.slot.startTime, entry.slot.endTime)}
                      </p>
                      <p className="mt-0.5 text-[11px] text-faint">{entry.slot.room}</p>
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-ink">
                        {entry.subject.name}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-muted">
                        {entry.subject.code} · {entry.teacherName}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {entry.record?.inTime && (
                      <span className="text-[11px] tabular-nums text-faint">
                        {entry.record.inTime}
                      </span>
                    )}
                    <StatusBadge status={entry.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ---------------------------------------------------- percentages */}
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-3">
            <StatTile
              label="Overall"
              value={formatPercentage(overall)}
              hint={`${totals.attended} of ${totals.held} periods`}
              tone={overallTone.text}
            />
            <StatTile
              label="Subjects below 75%"
              value={belowEligibility.length}
              hint={belowEligibility.length === 0 ? "All clear" : "Needs attention"}
              tone={belowEligibility.length > 0 ? "text-absent" : "text-present"}
            />
          </div>

          <Card>
            <CardHeader
              title="Attendance by subject"
              description="Present and late count as attended. Excused is left out of both sides."
            />
            {summary.loading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-muted">
                <Spinner />
                <span className="text-[13px]">Loading…</span>
              </div>
            ) : subjects.length === 0 ? (
              <EmptyState
                title="No attendance recorded yet"
                description="Once your first period is marked, the per-subject breakdown appears here."
              />
            ) : (
              <ul className="divide-y divide-line">
                {subjects.map((subject) => {
                  const tone = percentageTone(subject.percentage);
                  return (
                    <li key={subject.subjectId} className="px-5 py-3.5">
                      <div className="flex items-baseline justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-medium text-ink">
                            {subject.subjectName}
                          </p>
                          <p className="mt-0.5 text-[11px] text-muted">
                            {subject.subjectCode} · {subject.presentCount + subject.lateCount}/
                            {subject.heldCount - subject.excusedCount} attended
                            {subject.excusedCount > 0 && ` · ${subject.excusedCount} excused`}
                          </p>
                        </div>
                        <span className={`shrink-0 text-sm font-semibold tabular-nums ${tone.text}`}>
                          {formatPercentage(subject.percentage)}
                        </span>
                      </div>
                      <div className="relative mt-2.5">
                        <ProgressBar
                          value={subject.percentage}
                          barClassName={tone.bar}
                          label={`${subject.subjectName} attendance`}
                        />
                        {/* The eligibility line, drawn where 75% falls. */}
                        <span
                          className="absolute -top-0.5 h-2.5 w-px bg-line-strong"
                          style={{ left: `${ELIGIBILITY}%` }}
                          aria-hidden
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="border-t border-line px-5 py-3">
              <p className="text-[11px] text-faint">
                The tick on each bar marks {ELIGIBILITY}%.
              </p>
            </div>
          </Card>
        </div>
      </div>
    </PageBody>
  );
}
