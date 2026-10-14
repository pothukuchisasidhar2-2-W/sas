import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { api, errorMessage } from "../../api/client";
import { PageBody, PageHeader } from "../../components/AppShell";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  StatTile,
  StatusBadge,
  TableWrap,
  Td,
  Th,
  cx,
} from "../../components/ui";
import type { AttendanceStatus } from "../../api/types";
import { useAuth, useToken } from "../../lib/auth";
import { PERIOD_LABEL, isoToday } from "../../lib/format";
import { useApiData } from "../../lib/useApiData";

const MARK_OPTIONS: AttendanceStatus[] = ["present", "absent", "late", "excused"];

export default function TeacherClasses() {
  const { user } = useAuth();
  const token = useToken();
  const [params, setParams] = useSearchParams();

  const teacher = user?.role === "teacher" ? user.profile : null;

  const sections = useApiData([token], () => api.teacherSections(token));

  const [sectionChoice, setSectionChoice] = useState(params.get("section") ?? "");
  const [date, setDate] = useState(params.get("date") ?? isoToday());
  const [slotId, setSlotId] = useState(params.get("slot") ?? "");
  const [query, setQuery] = useState("");
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  // The class actually in view: whatever was chosen, otherwise the first class
  // in scope. Derived rather than stored, so arriving class data does not cost
  // a throwaway render pass.
  const sectionId = sectionChoice || sections.data?.[0]?.id || "";

  // Keep the URL in step so a period can be linked to directly from the
  // dashboard, and so a refresh lands back on the same roster.
  useEffect(() => {
    const next = new URLSearchParams();
    if (sectionId) next.set("section", sectionId);
    next.set("date", date);
    if (slotId) next.set("slot", slotId);
    setParams(next, { replace: true });
  }, [sectionId, date, slotId, setParams]);

  const periods = useApiData([token, date, sectionId], async () => {
    if (!sectionId) return [];
    const slots = await api.teacherSchedule(token, date);
    return slots.filter((slot) => slot.sectionId === sectionId);
  });

  // If the selected period is not on this date, fall back to "whole day".
  useEffect(() => {
    if (!slotId) return;
    const stillExists = (periods.data ?? []).some((slot) => slot.id === slotId);
    if (!stillExists && !periods.loading) setSlotId("");
  }, [periods.data, periods.loading, slotId]);

  const roster = useApiData([token, sectionId, date, slotId], async () => {
    if (!sectionId) return [];
    return api.teacherRoster(token, { sectionId, date, slotId: slotId || undefined });
  });
  const sessionState = useApiData([token, sectionId, date, slotId], async () => {
    if (!sectionId || !slotId) return { completed: false, completedAt: null };
    return api.attendanceSession(token, { sectionId, date, slotId });
  });

  const rows = roster.data ?? [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) || row.studentId.toLowerCase().includes(needle),
    );
  }, [rows, query]);

  const counts = useMemo(() => {
    const tally = { present: 0, absent: 0, late: 0, excused: 0, unmarked: 0 };
    for (const row of rows) tally[row.status] += 1;
    return tally;
  }, [rows]);
  const reviewCount = rows.filter((row) => row.reviewRequired).length;

  if (!user || user.role !== "teacher") return null;

  const activeSlot = (periods.data ?? []).find((slot) => slot.id === slotId) ?? null;
  const canMark = Boolean(activeSlot && activeSlot.teacherId === teacher?.userId
    && teacher.assignments.some((assignment) =>
      assignment.sectionId === sectionId && assignment.subjectId === activeSlot.subjectId,
    ));
  const member = teacher ? teacher.assignments.some((a) => a.sectionId === sectionId) : false;

  const mark = async (studentId: string, status: AttendanceStatus) => {
    if (!activeSlot) return;
    setBusyRow(studentId);
    setActionError(null);
    setActionNotice(null);
    try {
      await api.markAttendance(token, {
        studentId,
        slotId: activeSlot.id,
        date,
        status,
        sectionId,
      });
      roster.reload();
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setBusyRow(null);
    }
  };

  const completeSession = async () => {
    if (!activeSlot || !canMark) return;
    setBusyRow("__complete__");
    setActionError(null);
    setActionNotice(null);
    try {
      const result = await api.completeAttendanceSession(token, { sectionId, date, slotId: activeSlot.id });
      roster.reload();
      sessionState.reload();
      if (!result.completed) {
        setActionNotice(
          `${result.reviewRequired} camera attendance item(s) need your review. Set a period mark for each flagged student, then complete the session.`,
        );
      }
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setBusyRow(null);
    }
  };

  const reviewStudent = async (studentId: string, status: "approved" | "rejected") => {
    setBusyRow(studentId);
    setActionError(null);
    try {
      await api.reviewStudent(token, studentId, sectionId, status);
      roster.reload();
      sections.reload();
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setBusyRow(null);
    }
  };

  return (
    <PageBody>
      <PageHeader
        title="Attendance monitoring"
        description="Review student requests for your classes and manage period attendance. Attendance corrections are recorded as manual, not camera."
        actions={
          <Button variant="secondary" size="sm" onClick={roster.reload} loading={roster.loading}>
            Refresh
          </Button>
        }
      />

      {/* Filters */}
      <Card className="mb-5">
        <CardHeader
          title="Which class?"
          description="Pick a section, date and period to record or correct attendance. Camera sessions require teacher review for unobserved students and early exits."
        />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Class / section">
            <Select
              value={sectionId}
              onChange={(event) => setSectionChoice(event.target.value)}
            >
              {(sections.data ?? []).map((section) => (
                <option key={section.id} value={section.id}>
                  {section.id} · {section.strength} students
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Date">
            <Input
              type="date"
              value={date}
              max={isoToday()}
              onChange={(event) => event.target.value && setDate(event.target.value)}
            />
          </Field>

          <Field label="Period" hint={canMark ? undefined : "Day view — pick a period to edit"}>
            <Select value={slotId} onChange={(event) => setSlotId(event.target.value)}>
              <option value="">Whole day</option>
              {(periods.data ?? []).map((slot) => (
                <option key={slot.id} value={slot.id}>
                  {PERIOD_LABEL(slot.startTime, slot.endTime)} · {slot.subjectId}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Find a student">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name or roll number"
            />
          </Field>
        </CardBody>
      </Card>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile label="Present" value={counts.present} tone="text-present" />
        <StatTile label="Absent" value={counts.absent} tone="text-absent" />
        <StatTile label="Late" value={counts.late} tone="text-late" />
        <StatTile label="Not marked" value={counts.unmarked} tone="text-pending" />
        <StatTile label="Needs review" value={reviewCount} tone="text-late" />
      </div>

      {actionNotice && (
        <div className="mb-5">
          <Alert tone="warning" title="Teacher review required">{actionNotice}</Alert>
        </div>
      )}
      {actionError && (
        <div className="mb-5">
          <Alert tone="error">{actionError}</Alert>
        </div>
      )}

      {activeSlot && canMark && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4">
          {sessionState.loading ? (
            <span className="text-[13px] text-muted">Checking session status…</span>
          ) : sessionState.error ? (
            <Alert tone="error">{sessionState.error}</Alert>
          ) : sessionState.data?.completed ? (
            <Alert tone="success" title="Session completed">
              {sessionState.data.cameraSession
                ? "Camera attendance items were reviewed before completion. You can still correct individual marks."
                : "Remaining approved students were marked absent. You can still correct individual marks."}
            </Alert>
          ) : (
            <>
              <p className="text-[13px] text-muted">
                When this period is over, complete it. Camera sessions require teacher review for students not seen and early exits.
              </p>
              <Button
                variant="secondary"
                loading={busyRow === "__complete__"}
                disabled={date > isoToday() || periods.loading}
                onClick={completeSession}
              >
                Complete session
              </Button>
            </>
          )}
        </div>
      )}

      {!canMark && rows.length > 0 && (
        <div className="mb-5">
          <Alert tone="info" title="Day view">
            This is an aggregate of every period on {date}. Select a period above to correct
            individual marks.
          </Alert>
        </div>
      )}

      {teacher && !member && sectionId && (
        <div className="mb-5">
          <Alert tone="warning" title="Heads up">
            You are not assigned to {sectionId} yourself. You can see it because you are the HOD of
            its department — {teacher.isHod ? "that is expected" : "this may be a mistake"}.
          </Alert>
        </div>
      )}

      <Card>
        <CardHeader
          title={`${sectionId || "No class selected"} · ${date}`}
          description={
            activeSlot
              ? `${PERIOD_LABEL(activeSlot.startTime, activeSlot.endTime)} · ${activeSlot.subjectId} · ${activeSlot.room}`
              : "Aggregate across the day's periods"
          }
          action={<Badge tone="neutral">{rows.length} students</Badge>}
        />

        {sections.loading || roster.loading ? (
          <div className="flex items-center justify-center gap-2 py-14 text-muted">
            <Spinner />
            <span className="text-[13px]">Loading the roster…</span>
          </div>
        ) : roster.error ? (
          <CardBody>
            <Alert tone="error">{roster.error}</Alert>
          </CardBody>
        ) : (sections.data ?? []).length === 0 ? (
          <EmptyState
            title="No classes to show"
            description="You have no section assignments yet. Ask your HOD to add you, or create a department and add classes there."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No students match"
            description={query ? `Nothing matches "${query}".` : "This section has no students yet."}
          />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>Roll</Th>
                <Th>Name</Th>
                <Th>Membership</Th>
                <Th>Status</Th>
                <Th>Attendance review</Th>
                <Th>Marked</Th>
                <Th align="right">In time</Th>
                <Th align="right">Period mark</Th>
                <Th align="right">Class review</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.studentId} className="hover:bg-canvas">
                  <Td className="font-medium tabular-nums">{row.studentId}</Td>
                  <Td>{row.name}</Td>
                  <Td>
                    {row.enrollmentStatus === "pending" ? <Badge tone="late">Pending review</Badge>
                      : row.enrollmentStatus === "rejected" ? <Badge tone="absent">Rejected</Badge>
                      : <Badge tone="present">Approved</Badge>}
                  </Td>
                  <Td>
                    <StatusBadge status={row.status} />
                  </Td>
                  <Td>
                    {row.reviewRequired ? (
                      <Badge tone="late">
                        {row.reviewReason === "early_exit" ? "Early exit" : "Not seen"}
                      </Badge>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </Td>
                  <Td>
                    {row.method === "face" ? (
                      <Badge tone="brand">Camera</Badge>
                    ) : row.method === "manual" ? (
                      <Badge tone="neutral">Manual</Badge>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </Td>
                  <Td align="right" className="tabular-nums text-muted">
                    {row.inTime ?? "—"}
                  </Td>
                  <Td align="right">
                    {canMark && row.enrollmentStatus === "approved" ? (
                      <div className="flex justify-end gap-1">
                        {MARK_OPTIONS.map((status) => (
                          <button
                            key={status}
                            type="button"
                            disabled={busyRow === row.studentId}
                            onClick={() => mark(row.studentId, status)}
                            title={`Mark ${status}`}
                            className={cx(
                              "size-6 rounded-full border text-[10px] font-semibold uppercase transition-colors",
                              row.status === status
                                ? "border-brand bg-brand text-white"
                                : "border-line-strong text-muted hover:border-brand hover:text-brand",
                              busyRow === row.studentId && "opacity-40",
                            )}
                          >
                            {status[0]}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </Td>
                  <Td align="right">
                    {row.enrollmentStatus === "approved" ? (
                      <Button size="sm" variant="ghost" disabled={busyRow === row.studentId} onClick={() => reviewStudent(row.studentId, "rejected")}>
                        Remove from class
                      </Button>
                    ) : (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="secondary" disabled={busyRow === row.studentId} onClick={() => reviewStudent(row.studentId, "approved")}>
                          Approve
                        </Button>
                        {row.enrollmentStatus === "pending" && (
                          <Button size="sm" variant="ghost" disabled={busyRow === row.studentId} onClick={() => reviewStudent(row.studentId, "rejected")}>
                            Reject
                          </Button>
                        )}
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </PageBody>
  );
}
