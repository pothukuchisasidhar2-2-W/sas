import { useMemo } from "react";

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
  TableWrap,
  Td,
  Th,
} from "../../components/ui";
import { useAuth, useToken } from "../../lib/auth";
import { DAY_NAMES, isoToday } from "../../lib/format";
import { useApiData } from "../../lib/useApiData";

/** Monday → Saturday, matching the slot model (dayOfWeek 1–6). */
const WEEKDAYS = [1, 2, 3, 4, 5, 6];

export default function StudentTimetable() {
  const { user } = useAuth();
  const token = useToken();

  // Hooks first — see the note in StudentAttendance.
  const student = user?.role === "student" ? user.profile : null;
  const sectionId = student?.sectionId ?? "";

  const timetable = useApiData([token, sectionId], () => api.sectionTimetable(token, sectionId));

  const slots = useMemo(() => timetable.data ?? [], [timetable.data]);

  const { periods, grid } = useMemo(() => {
    const starts = [...new Set(slots.map((slot) => slot.startTime))].sort();
    const byKey = new Map<string, (typeof slots)[number]>();
    for (const slot of slots) byKey.set(`${slot.dayOfWeek}|${slot.startTime}`, slot);
    return { periods: starts, grid: byKey };
  }, [slots]);

  const todayDow = new Date(`${isoToday()}T00:00:00`).getDay();

  if (!student) return null;

  return (
    <PageBody>
      <PageHeader
        title="Weekly timetable"
        description={`The published schedule for ${student.sectionId}.`}
        actions={<Badge tone="brand">{student.sectionId}</Badge>}
      />

      <Card>
        <CardHeader
          title="Period grid"
          description="Today's column is highlighted."
        />

        {timetable.loading ? (
          <div className="flex items-center justify-center gap-2 py-14 text-muted">
            <Spinner />
            <span className="text-[13px]">Loading the timetable…</span>
          </div>
        ) : timetable.error ? (
          <CardBody>
            <Alert tone="error">{timetable.error}</Alert>
          </CardBody>
        ) : slots.length === 0 ? (
          <EmptyState
            title="No timetable published yet"
            description="Your class teacher needs to upload the timetable for this section. It will appear here automatically."
          />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th className="w-28">Time</Th>
                {WEEKDAYS.map((day) => (
                  <Th key={day} className={day === todayDow ? "text-brand" : undefined}>
                    {DAY_NAMES[day].slice(0, 3)}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {periods.map((start) => (
                <tr key={start}>
                  <Td className="font-medium tabular-nums text-muted">{start}</Td>
                  {WEEKDAYS.map((day) => {
                    const slot = grid.get(`${day}|${start}`);
                    if (!slot) {
                      return (
                        <Td key={day} className="bg-canvas/60 text-faint">
                          —
                        </Td>
                      );
                    }
                    return (
                      <Td
                        key={day}
                        className={day === todayDow ? "bg-brand-soft/50" : undefined}
                      >
                        <p className="text-[13px] font-medium text-ink">{slot.subjectId}</p>
                        <p className="mt-0.5 text-[11px] text-muted">{slot.room}</p>
                      </Td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </PageBody>
  );
}
