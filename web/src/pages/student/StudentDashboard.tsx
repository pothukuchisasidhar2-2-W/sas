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
const REQUESTED_THRESHOLD = Number(import.meta.env.VITE_ATTENDANCE_THRESHOLD ?? ELIGIBILITY);
const ATTENDANCE_THRESHOLD = Number.isFinite(REQUESTED_THRESHOLD) && REQUESTED_THRESHOLD > 0 && REQUESTED_THRESHOLD < 100
  ? REQUESTED_THRESHOLD
  : ELIGIBILITY;

export default function StudentDashboard() {
  const { user, refresh } = useAuth();
  const token = useToken();
  const [date, setDate] = useState(isoToday());

  const eligible = user?.role === "student" && user.profile.enrollmentStatus !== "pending" && user.profile.enrollmentStatus !== "rejected";
  const summary = useApiData([token, eligible], () => eligible ? api.studentSummary(token) : Promise.resolve([]));
  const recent = useApiData([token, eligible], () => eligible ? api.studentAttendance(token, "0001-01-01", isoToday()) : Promise.resolve([]));
  const schedule = useApiData([token, date, eligible], () => eligible ? api.studentSchedule(token, date) : Promise.resolve([]));

  if (!user || user.role !== "student") return null;
  const student = user.profile;

  if (student.enrollmentStatus === "pending" || student.enrollmentStatus === "rejected") {
    return (
      <PageBody>
        <PageHeader title={`Hello, ${student.name.split(" ")[0]}`} description={student.sectionId} />
        <Alert tone={student.enrollmentStatus === "pending" ? "warning" : "error"}
          title={student.enrollmentStatus === "pending" ? "Waiting for teacher approval" : "Class request was declined"}>
          {student.enrollmentStatus === "pending"
            ? "Your face registration and class details were received. A teacher assigned to your class must approve your membership before attendance records are available."
            : "A teacher declined your class request. Contact the teacher or correct your class details with the SAHE attendance administrator."}
        </Alert>
        <div className="mt-4"><Button variant="secondary" onClick={() => void refresh()}>Check approval status</Button></div>
        {!student.faceEnrolled && <div className="mt-4"><Link to="/student/enroll"><Button>Capture face photo</Button></Link></div>}
      </PageBody>
    );
  }

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
    (subject) => subject.percentage !== null && subject.percentage < ATTENDANCE_THRESHOLD,
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
                      {entry.slot.dateChange && (
                        <Badge tone={entry.slot.dateChange === "added" ? "brand" : "late"}>
                          {entry.slot.dateChange === "added" ? "Extra period" : "Changed"}
                        </Badge>
                      )}
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
              hint={totals.held ? `${totals.attended} of ${totals.held} completed class periods` : "No completed subject-linked sessions yet"}
              tone={overallTone.text}
            />
            <StatTile
              label="Recognition days"
              value={recent.data?.filter((record) => record.method === "face").length ?? "—"}
              hint="Legacy camera records without class assignment"
              tone="text-ink"
            />
          </div>

          {belowEligibility.length > 0 && (
            <Alert tone="warning" title={`${belowEligibility.length} subject${belowEligibility.length === 1 ? "" : "s"} below ${ATTENDANCE_THRESHOLD}%`}>
              Attendance is compared with the threshold configured for SAHE.
            </Alert>
          )}

          {totals.held === 0 && (recent.data?.length ?? 0) > 0 && (
            <Alert tone="info" title="Class percentage is not available yet">
              Camera attendance exists, but the existing recognizer records only a student and date. It does not identify a scheduled subject or count classes where nobody was recognized.
            </Alert>
          )}

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
                            {subject.heldCount - subject.excusedCount} marked
                            {subject.excusedCount > 0 && ` · ${subject.excusedCount} excused`}
                          </p>
                        </div>
                        <span className={`shrink-0 text-sm font-semibold tabular-nums ${tone.text}`}>
                          {formatPercentage(subject.percentage)}
                        </span>
                      </div>
                      {subject.percentage !== null && subject.percentage < ATTENDANCE_THRESHOLD && subject.percentage < 100 && (
                        <p className="mt-1 text-[11px] text-muted">
                          Estimate: attend the next {Math.max(0, Math.ceil((ATTENDANCE_THRESHOLD * (subject.heldCount - subject.excusedCount) / 100 - (subject.presentCount + subject.lateCount)) / (1 - ATTENDANCE_THRESHOLD / 100)))} classes to reach {ATTENDANCE_THRESHOLD}%, assuming no further absences.
                        </p>
                      )}
                      <div className="relative mt-2.5">
                        <ProgressBar
                          value={subject.percentage}
                          barClassName={tone.bar}
                          label={`${subject.subjectName} attendance`}
                        />
                        {/* The eligibility line, drawn where 75% falls. */}
                        <span
                          className="absolute -top-0.5 h-2.5 w-px bg-line-strong"
                          style={{ left: `${ATTENDANCE_THRESHOLD}%` }}
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
                The tick marks the configured {ATTENDANCE_THRESHOLD}% threshold. Class percentages only include periods explicitly marked in SAHE Attendance.
              </p>
            </div>
          </Card>
        </div>
      </div>
    </PageBody>
  );
}
