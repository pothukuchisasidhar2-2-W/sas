import { useRef, useState } from "react";

import { api, errorMessage } from "../../api/client";
import type { TimetableUploadResult } from "../../api/contract";
import type { TimetableChangeInput, TimetableChangePreview } from "../../api/types";
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
} from "../../components/ui";
import { useAuth, useToken } from "../../lib/auth";
import { DAY_NAMES, PERIOD_LABEL, formatLongDate, isoToday } from "../../lib/format";
import { useApiData } from "../../lib/useApiData";

type PreviewSlot = {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  subjectId: string;
  subjectName?: string;
  room: string;
};

function WeekGrid({ slots, emptyText }: { slots: PreviewSlot[]; emptyText: string }) {
  if (!slots.length) return <p className="py-8 text-center text-sm text-muted">{emptyText}</p>;
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[900px] grid-cols-6 gap-2">
        {[1, 2, 3, 4, 5, 6].map((day) => {
          const daySlots = slots.filter((slot) => slot.dayOfWeek === day).sort((a, b) => a.startTime.localeCompare(b.startTime));
          return (
            <div key={day} className="min-h-32 rounded-field border border-line bg-canvas/60 p-2">
              <h3 className="mb-2 border-b border-line pb-2 text-xs font-semibold text-ink">{DAY_NAMES[day]}</h3>
              <div className="flex flex-col gap-2">
                {daySlots.length ? daySlots.map((slot) => (
                  <article key={slot.id} className="rounded-field border border-brand/15 bg-brand-soft px-2 py-2">
                    <p className="text-[10px] tabular-nums text-brand">{PERIOD_LABEL(slot.startTime, slot.endTime)}</p>
                    <p className="mt-1 break-words text-xs font-semibold text-ink">{slot.subjectName || slot.subjectId}</p>
                    <p className="text-[10px] text-muted">{slot.subjectId}</p>
                    {slot.room && <p className="mt-0.5 text-[10px] text-muted">{slot.room}</p>}
                  </article>
                )) : <p className="py-3 text-center text-[10px] text-faint">No classes</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function TeacherTimetable() {
  const { user } = useAuth();
  const token = useToken();

  const sections = useApiData([token], () => api.teacherSections(token));
  const [sectionChoice, setSectionChoice] = useState("");
  const [changeDate, setChangeDate] = useState(isoToday());
  const [changeKind, setChangeKind] = useState<TimetableChangeInput["kind"]>("modify");
  const [changeSlotId, setChangeSlotId] = useState("");
  const [changeSubjectId, setChangeSubjectId] = useState("");
  const [changeStart, setChangeStart] = useState("");
  const [changeEnd, setChangeEnd] = useState("");
  const [changeRoom, setChangeRoom] = useState("");
  const [changePreview, setChangePreview] = useState<TimetableChangePreview | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [changeSuccess, setChangeSuccess] = useState<string | null>(null);
  const [changeBusy, setChangeBusy] = useState(false);
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [draggingFile, setDraggingFile] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<TimetableUploadResult | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const teacher = user?.role === "teacher" ? user.profile : null;

  // Derived, not stored — see TeacherClasses for the reasoning.
  const sectionId = sectionChoice || sections.data?.[0]?.id || "";

  const timetable = useApiData([token, sectionId], async () => {
    if (!sectionId) return [];
    return api.sectionTimetable(token, sectionId);
  });
  const dateSchedule = useApiData([token, sectionId, changeDate], async () => {
    if (!sectionId || !changeDate) return [];
    return api.sectionTimetable(token, sectionId, changeDate);
  });

  if (!user || user.role !== "teacher") return null;

  const slots = timetable.data ?? [];
  const selectedDate = changeDate ? new Date(`${changeDate}T00:00:00`) : null;
  const selectedWeekday = selectedDate ? selectedDate.getDay() : -1;
  const selectedWeekdayIso = selectedWeekday === 0 ? 7 : selectedWeekday;
  const recurringForDate = slots
    .filter((slot) => slot.dayOfWeek === selectedWeekdayIso)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
  const assignedSubjects = teacher?.assignments.filter((item) => item.sectionId === sectionId) ?? [];
  const assignedSubjectIds = new Set(assignedSubjects.map((assignment) => assignment.subjectId));
  const scheduledForDate = (dateSchedule.data ?? []).filter((slot) =>
    assignedSubjectIds.has(slot.subjectId),
  );
  const selectablePeriods = changeKind === "modify"
    ? scheduledForDate.filter((slot) => slot.dateChange !== "added")
    : scheduledForDate;

  const changeInput = (): TimetableChangeInput => ({
    date: changeDate,
    sectionId,
    kind: changeKind,
    ...(changeKind === "add"
      ? { subjectId: changeSubjectId, startTime: changeStart, endTime: changeEnd, room: changeRoom }
      : changeKind === "modify"
        ? { slotId: changeSlotId, startTime: changeStart, endTime: changeEnd, room: changeRoom }
        : { slotId: changeSlotId }),
  });

  const previewChange = async () => {
    setChangeBusy(true);
    setChangeError(null);
    setChangeSuccess(null);
    try {
      setChangePreview(await api.previewTimetableChange(token, changeInput()));
    } catch (cause) {
      setChangePreview(null);
      setChangeError(errorMessage(cause));
    } finally {
      setChangeBusy(false);
    }
  };

  const publishChange = async () => {
    setChangeBusy(true);
    setChangeError(null);
    try {
      const result = await api.createTimetableChange(token, changeInput());
      setChangeSuccess(result.message);
      setChangePreview(null);
      setChangeSlotId("");
      setChangeSubjectId("");
      setChangeStart("");
      setChangeEnd("");
      setChangeRoom("");
      dateSchedule.reload();
    } catch (cause) {
      setChangeError(errorMessage(cause));
    } finally {
      setChangeBusy(false);
    }
  };

  const loadFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Choose a CSV file. Excel workbooks must be saved as CSV UTF-8 first.");
      return;
    }
    setError(null);
    try {
      const contents = await file.text();
      if (!contents.trim()) {
        setError("That file is empty. Add timetable rows and try again.");
        return;
      }
      setCsv(contents);
      setFileName(file.name);
      setResult(null);
      setPreviewReady(false);
      await preview(contents);
    } catch (cause) {
      setError(`Could not read that file: ${errorMessage(cause)}`);
    }
  };

  const upload = async () => {
    if (!sectionId) {
      setError("Choose a class first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await api.uploadTimetable(token, { sectionId, csv });
      setResult(outcome);
      setPreviewReady(false);
      setCsv("");
      setFileName("");
      timetable.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const preview = async (csvText = csv) => {
    if (!sectionId) {
      setError("Choose a class first.");
      return;
    }
    setBusy(true);
    setError(null);
    setPreviewReady(false);
    try {
      setResult(await api.previewTimetable(token, { sectionId, csv: csvText }));
      setPreviewReady(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const proposedSlots = previewReady && result && result.imported + result.replaced > 0 ? result.preview ?? [] : [];
  const publishedSlots: PreviewSlot[] = slots.map((slot) => ({
    id: slot.id,
    dayOfWeek: slot.dayOfWeek,
    startTime: slot.startTime,
    endTime: slot.endTime,
    subjectId: slot.subjectId,
    room: slot.room,
  }));

  return (
    <PageBody>
      <PageHeader
        title="Timetable"
        description="Upload a class schedule, review it as a weekly grid, then publish it for students and attendance."
        actions={<Badge tone="brand">{sectionId || "No class selected"}</Badge>}
      />

      <Card className="mb-5">
        <CardHeader title="Class" description="Only classes in your scope are listed." />
        <CardBody className="max-w-sm">
          <Field label="Class / section">
            <Select
              value={sectionId}
              onChange={(event) => {
                setSectionChoice(event.target.value);
                setPreviewReady(false);
                setResult(null);
                setError(null);
                setChangeSlotId("");
                setChangeSubjectId("");
                setChangeStart("");
                setChangeEnd("");
                setChangeRoom("");
                setChangePreview(null);
                setChangeError(null);
                setChangeSuccess(null);
              }}
            >
              {(sections.data ?? []).map((section) => (
                <option key={section.id} value={section.id}>
                  {section.id}
                </option>
              ))}
            </Select>
          </Field>
        </CardBody>
      </Card>

      <Card className="mb-5">
        <CardHeader
          title="One-time change"
          description="Adjust this class for one date only. The weekly timetable stays unchanged."
        />
        <CardBody className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date">
              <Input
                type="date"
                value={changeDate}
                onChange={(event) => {
                  setChangeDate(event.target.value);
                  setChangePreview(null);
                  setChangeError(null);
                  setChangeSuccess(null);
                  setChangeSlotId("");
                  setChangeSubjectId("");
                  setChangeStart("");
                  setChangeEnd("");
                  setChangeRoom("");
                }}
              />
            </Field>
            <Field label="Change type">
              <Select
                value={changeKind}
                onChange={(event) => {
                  setChangeKind(event.target.value as TimetableChangeInput["kind"]);
                  setChangePreview(null);
                  setChangeError(null);
                  setChangeSuccess(null);
                  setChangeSlotId("");
                  setChangeSubjectId("");
                  setChangeStart("");
                  setChangeEnd("");
                  setChangeRoom("");
                }}
              >
                <option value="modify">Change a period's time or room</option>
                <option value="cancel">Cancel a period</option>
                <option value="add">Add an extra period</option>
              </Select>
            </Field>
          </div>

          {changeKind !== "add" ? (
            <Field label="Scheduled period">
              <Select
                value={changeSlotId}
                onChange={(event) => {
                  const selected = selectablePeriods.find((slot) => slot.id === event.target.value);
                  setChangeSlotId(event.target.value);
                  setChangeStart(selected?.startTime ?? "");
                  setChangeEnd(selected?.endTime ?? "");
                  setChangeRoom(selected?.room ?? "");
                  setChangePreview(null);
                  setChangeError(null);
                }}
              >
                <option value="">Choose a period</option>
                {selectablePeriods.map((slot) => (
                  <option key={slot.id} value={slot.id}>
                    {slot.startTime}–{slot.endTime} · {slot.subjectId}
                    {slot.dateChange === "added" ? " · extra period" : ""}
                    {slot.room ? ` · ${slot.room}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="Assigned subject">
              <Select
                value={changeSubjectId}
                onChange={(event) => {
                  setChangeSubjectId(event.target.value);
                  setChangePreview(null);
                  setChangeError(null);
                }}
              >
                <option value="">Choose a subject</option>
                {assignedSubjects.map((assignment) => (
                  <option key={assignment.subjectId} value={assignment.subjectId}>
                    {assignment.subjectCode} · {assignment.subjectName}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {changeKind !== "cancel" && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Start time">
                <Input
                  type="time"
                  value={changeStart}
                  onChange={(event) => {
                    setChangeStart(event.target.value);
                    setChangePreview(null);
                  }}
                />
              </Field>
              <Field label="End time">
                <Input
                  type="time"
                  value={changeEnd}
                  onChange={(event) => {
                    setChangeEnd(event.target.value);
                    setChangePreview(null);
                  }}
                />
              </Field>
              <Field label="Room">
                <Input
                  value={changeRoom}
                  onChange={(event) => {
                    setChangeRoom(event.target.value);
                    setChangePreview(null);
                  }}
                  placeholder="Optional"
                />
              </Field>
            </div>
          )}

          {changeError && <Alert tone="error">{changeError}</Alert>}
          {changeSuccess && <Alert tone="success">{changeSuccess} Students will see it on this date.</Alert>}
          {changePreview && (
            <Alert
              tone="warning"
              title="Review before publishing"
            >
              {changePreview.kind === "cancel"
                ? `Cancel ${changePreview.slot.dateChange === "added" ? "the extra period for " : ""}${changePreview.slot.subjectId} at ${changePreview.slot.startTime}–${changePreview.slot.endTime} on ${formatLongDate(changePreview.date)}?`
                : `${changePreview.kind === "add" ? "Add" : "Change"} ${changePreview.slot.subjectId} to ${changePreview.slot.startTime}–${changePreview.slot.endTime}${changePreview.slot.room ? ` in ${changePreview.slot.room}` : ""} on ${formatLongDate(changePreview.date)}?`}
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            {!changePreview ? (
              <Button
                onClick={previewChange}
                loading={changeBusy}
                disabled={!sectionId || !changeDate || (changeKind === "add"
                  ? !changeSubjectId || !changeStart || !changeEnd
                  : !changeSlotId)}
              >
                Preview change
              </Button>
            ) : (
              <Button onClick={publishChange} loading={changeBusy}>
                Publish for this date
              </Button>
            )}
          </div>

          <div className="border-t border-line pt-4">
            <p className="mb-2 text-[13px] font-medium text-ink">
              Schedule for {changeDate ? formatLongDate(changeDate) : "selected date"}
            </p>
            {dateSchedule.loading ? (
              <div className="flex items-center gap-2 py-3 text-muted"><Spinner /> Loading schedule…</div>
            ) : dateSchedule.error ? (
              <Alert tone="error">{dateSchedule.error}</Alert>
            ) : dateSchedule.data?.length ? (
              <ul className="divide-y divide-line">
                {dateSchedule.data.map((slot) => (
                  <li key={slot.id} className="flex flex-wrap items-center gap-2 py-2 text-[13px]">
                    <span className="w-28 tabular-nums text-muted">
                      {PERIOD_LABEL(slot.startTime, slot.endTime)}
                    </span>
                    <span className="font-medium text-ink">{slot.subjectId}</span>
                    <span className="text-muted">{slot.room}</span>
                    {slot.dateChange && (
                      <Badge tone={slot.dateChange === "added" ? "brand" : "late"}>
                        {slot.dateChange === "added" ? "Extra period" : "Changed"}
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rounded-field bg-canvas px-3 py-3">
                <p className="text-xs font-medium text-ink">No one-time changes for this date.</p>
                {recurringForDate.length ? (
                  <>
                    <p className="mt-1 text-xs text-muted">The regular {selectedDate ? DAY_NAMES[selectedDate.getDay()] : "weekly"} timetable still applies:</p>
                    <ul className="mt-2 divide-y divide-line">
                      {recurringForDate.map((slot) => (
                        <li key={slot.id} className="flex flex-wrap items-center gap-2 py-2 text-[13px]">
                          <span className="w-28 tabular-nums text-muted">{PERIOD_LABEL(slot.startTime, slot.endTime)}</span>
                          <span className="font-medium text-ink">{slot.subjectId}</span>
                          <span className="text-muted">{slot.room}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="mt-1 text-xs text-muted">There are no regular periods on this weekday.</p>
                )}
              </div>
            )}
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Current schedule */}
        <Card>
          <CardHeader
            title="Published schedule"
            description={`${slots.length} period${slots.length === 1 ? "" : "s"} on the grid`}
            action={
              <Button variant="secondary" size="sm" onClick={timetable.reload}>
                Refresh
              </Button>
            }
          />

          {timetable.loading ? (
            <div className="flex items-center justify-center gap-2 py-14 text-muted">
              <Spinner />
            </div>
          ) : slots.length === 0 ? (
            <EmptyState
              title="Nothing published yet"
              description="Add real class periods, review the CSV and publish it. The periods will appear here."
            />
          ) : <CardBody className="pt-4"><WeekGrid slots={publishedSlots} emptyText="No periods published." /></CardBody>}
        </Card>

        {/* Upload */}
        <Card>
          <CardHeader
            title="Upload weekly timetable"
            description="Choose a CSV, review the import, then publish it for this class."
          />
          <CardBody className="flex flex-col gap-4">
            <div
              className={`rounded-card border border-dashed p-4 transition-colors ${
                draggingFile ? "border-brand bg-brand-soft" : "border-line-strong bg-canvas"
              }`}
              onDragOver={(event) => {
                event.preventDefault();
                setDraggingFile(true);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDraggingFile(false);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDraggingFile(false);
                const file = event.dataTransfer.files[0];
                if (file) void loadFile(file);
              }}
            >
              <input
                ref={fileInput}
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                aria-label="Choose a timetable CSV file"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void loadFile(file);
                }}
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[13px] font-medium text-ink">
                    {fileName || "Choose a timetable CSV"}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {busy && fileName
                      ? "Checking rows against your assigned subjects…"
                      : previewReady && result
                        ? `${result.imported + result.replaced} valid period${result.imported + result.replaced === 1 ? "" : "s"}. Review the weekly grid below.`
                        : fileName
                          ? "File loaded. Review the timetable to prepare its preview."
                          : "Drag a .csv file here, or choose one from your device."}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => fileInput.current?.click()}
                >
                  Choose file
                </Button>
              </div>
            </div>

            <p className="text-xs leading-relaxed text-muted">
              Need a spreadsheet? Download the template, fill one row per period, then save or
              export it as <span className="font-medium text-ink">CSV UTF-8</span>. Excel (.xlsx)
              files are not supported yet.
            </p>

            {fileName && <p className="text-xs text-muted">CSV columns: day, start, end, subject code, subject name, section. Room is optional; only assigned subjects for this class can be published.</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void preview()} loading={busy} disabled={!csv.trim() || !sectionId || previewReady}>
                {previewReady ? "Timetable reviewed" : "Review timetable"}
              </Button>
              {previewReady && result && result.imported + result.replaced > 0 && (
                <Button variant="secondary" onClick={upload} loading={busy}>
                  Publish {result.imported + result.replaced} period{result.imported + result.replaced === 1 ? "" : "s"}
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setCsv("");
                  setFileName("");
                  setResult(null);
                  setPreviewReady(false);
                  setError(null);
                }}
              >
                Clear
              </Button>
            </div>

            {error && <Alert tone="error">{error}</Alert>}

            {result && (
              <Alert
                tone={result.imported + result.replaced === 0 || result.errors.length > 0 ? "warning" : "success"}
                title={previewReady
                  ? result.imported + result.replaced > 0
                    ? `Ready to publish: ${result.imported + result.replaced} valid period${result.imported + result.replaced === 1 ? "" : "s"}`
                    : "No timetable periods found"
                  : `Imported ${result.imported} new, replaced ${result.replaced}`}
              >
                {previewReady && result.imported + result.replaced === 0 ? (
                  <>
                    <p>This file has no valid class periods yet. If you selected the downloaded template, open it in a spreadsheet, add one row per period, save it as CSV UTF-8, then choose it here again.</p>
                    {result.errors.length > 0 && <ul className="mt-1 flex flex-col gap-1">{result.errors.map((message) => <li key={message}>{message}</li>)}</ul>}
                  </>
                ) : result.errors.length === 0 ? (
                  previewReady
                    ? `${result.imported} new and ${result.replaced} existing periods. Invalid rows, if any, are listed below and will be skipped.`
                    : "The timetable is published for this class. The schedule on the left has been refreshed."
                ) : (
                  <ul className="mt-1 flex flex-col gap-1">
                    {result.errors.map((message) => (
                      <li key={message}>• {message}</li>
                    ))}
                  </ul>
                )}
              </Alert>
            )}

            {previewReady && result && result.imported + result.replaced > 0 && (
              <div className="rounded-field border border-line p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[13px] font-semibold text-ink">Weekly CSV preview</p>
                    <p className="text-xs text-muted">{proposedSlots.length} readable periods across the week for {sectionId}</p>
                  </div>
                  <Badge tone="brand">Not published</Badge>
                </div>
                <WeekGrid slots={proposedSlots} emptyText="No valid periods to preview." />
                {result.errors.length > 0 && <p className="mt-3 text-xs text-muted">The grid shows rows accepted by validation. Review rejected rows in the warning above.</p>}
              </div>
            )}
            {previewReady && result && result.imported + result.replaced > 0 && (
              <p className="text-xs leading-relaxed text-muted">Publishing makes this schedule available to students and uses its periods for attendance.</p>
            )}
            {!previewReady && result && (
              <Alert tone="success" title="Timetable published">
                {result.imported} new and {result.replaced} existing periods saved. The weekly schedule has been refreshed.
              </Alert>
            )}
          </CardBody>
        </Card>
      </div>
    </PageBody>
  );
}
