import { useMemo, useState } from "react";

import { api } from "../../api/client";
import { PageBody, PageHeader } from "../../components/AppShell";
import {
  Alert,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatTile,
  StatusBadge,
  TableWrap,
  Td,
  Th,
  cx,
} from "../../components/ui";
import { useAuth, useToken } from "../../lib/auth";
import {
  DAY_NAMES,
  PERIOD_LABEL,
  STATUS_META,
  addDaysIso,
  formatDate,
  formatPercentage,
  isoToday,
  parseIsoDate,
} from "../../lib/format";
import { useApiData } from "../../lib/useApiData";
import type { AttendanceStatus } from "../../api/types";

const RANGES = [
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "56", label: "Last 8 weeks", days: 56 },
] as const;

type RangeId = (typeof RANGES)[number]["id"];

export default function StudentAttendance() {
  const { user } = useAuth();
  const token = useToken();
  const [range, setRange] = useState<RangeId>("30");

  // Every hook runs before any early return. A conditional hook would change
  // the hook order between renders and crash React the moment the session
  // changed underneath this page.
  const student = user?.role === "student" ? user.profile : null;
  const sectionId = student?.sectionId ?? "";

  const days = RANGES.find((item) => item.id === range)!.days;
  const from = addDaysIso(isoToday(), -(days - 1));
  const to = isoToday();

  const records = useApiData([token, from, to], () => api.studentAttendance(token, from, to));
  const timetable = useApiData([token, sectionId], () => api.sectionTimetable(token, sectionId));

  const slotById = useMemo(() => {
    const map = new Map<string, { startTime: string; endTime: string; room: string }>();
    for (const slot of timetable.data ?? []) {
      map.set(slot.id, { startTime: slot.startTime, endTime: slot.endTime, room: slot.room });
    }
    return map;
  }, [timetable.data]);

  const rows = useMemo(() => records.data ?? [], [records.data]);
  const counts = useMemo(() => {
    const tally: Record<AttendanceStatus, number> = {
      present: 0,
      absent: 0,
      late: 0,
      excused: 0,
      unmarked: 0,
    };
    for (const record of rows) tally[record.status] += 1;
    return tally;
  }, [rows]);

  const counted = counts.present + counts.late;
  const denominator = rows.length - counts.excused;
  const percentage = denominator > 0 ? (counted / denominator) * 100 : null;

  if (!student) return null;

  return (
    <PageBody>
      <PageHeader
        title="Attendance"
        description={`Every marked period for ${student.sectionId} in the selected window.`}
        actions={
          <div className="flex gap-1 rounded-field border border-line bg-surface p-1">
            {RANGES.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setRange(option.id)}
                aria-pressed={range === option.id}
                className={cx(
                  "rounded-[6px] px-3 py-1.5 text-[13px] font-medium transition-colors",
                  range === option.id
                    ? "bg-brand-soft text-brand"
                    : "text-muted hover:bg-canvas hover:text-ink",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Attendance"
          value={formatPercentage(percentage)}
          hint={`${counted} of ${denominator} periods`}
        />
        <StatTile label="Present" value={counts.present} tone="text-present" />
        <StatTile label="Absent" value={counts.absent} tone="text-absent" />
        <StatTile
          label="Late / excused"
          value={`${counts.late} / ${counts.excused}`}
          tone="text-late"
        />
      </div>

      <Card>
        <CardHeader
          title="Period log"
          description={`${formatDate(from)} – ${formatDate(to)}`}
          action={
            <div className="flex flex-wrap gap-1.5">
              {(["present", "absent", "late", "excused"] as AttendanceStatus[]).map((status) => (
                <StatusBadge key={status} status={status} />
              ))}
            </div>
          }
        />

        {records.loading ? (
          <div className="flex items-center justify-center gap-2 py-14 text-muted">
            <Spinner />
            <span className="text-[13px]">Loading your attendance…</span>
          </div>
        ) : records.error ? (
          <CardBody>
            <Alert tone="error">{records.error}</Alert>
          </CardBody>
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing marked in this window"
            description="Either no classes were held, or the camera did not recognise anyone. Try a longer range."
          />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Period</Th>
                <Th>Subject</Th>
                <Th>Status</Th>
                <Th>Marked by</Th>
                <Th align="right">In time</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((record) => {
                const slot = slotById.get(record.slotId);
                const date = parseIsoDate(record.date);
                return (
                  <tr key={record.id} className="hover:bg-canvas">
                    <Td>
                      <span className="font-medium tabular-nums">{formatDate(record.date)}</span>
                      <span className="ml-2 text-[11px] text-faint">
                        {DAY_NAMES[date.getDay()].slice(0, 3)}
                      </span>
                    </Td>
                    <Td className="tabular-nums text-muted">
                      {slot ? PERIOD_LABEL(slot.startTime, slot.endTime) : "—"}
                    </Td>
                    <Td>
                      <span className="font-medium">{record.subjectId}</span>
                    </Td>
                    <Td>
                      <StatusBadge status={record.status} />
                    </Td>
                    <Td>
                      {record.method === "face" ? (
                        <Badge tone="brand">Camera</Badge>
                      ) : (
                        <Badge tone="neutral">Manual</Badge>
                      )}
                    </Td>
                    <Td align="right" className="tabular-nums text-muted">
                      {record.inTime ?? "—"}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <Card className="mt-5">
        <CardHeader
          title="What the statuses mean"
          description="Colour is never the only signal — every row also carries its label."
        />
        <CardBody className="grid gap-3 sm:grid-cols-2">
          {(["present", "absent", "late", "excused", "unmarked"] as AttendanceStatus[]).map(
            (status) => (
              <div key={status} className="flex items-start gap-3">
                <StatusBadge status={status} className="mt-0.5 shrink-0" />
                <p className="text-xs leading-relaxed text-muted">
                  {STATUS_META[status].description}
                </p>
              </div>
            ),
          )}
        </CardBody>
      </Card>
    </PageBody>
  );
}
