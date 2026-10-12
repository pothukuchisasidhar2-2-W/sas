import { useState } from "react";

import { api, errorMessage } from "../../api/client";
import type { TimetableUploadResult } from "../../api/contract";
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
  Select,
  Spinner,
  TableWrap,
  Td,
  Th,
  Textarea,
} from "../../components/ui";
import { useAuth, useToken } from "../../lib/auth";
import { DAY_NAMES, PERIOD_LABEL } from "../../lib/format";
import { useApiData } from "../../lib/useApiData";

const HEADER = "day,start,end,subject_code,subject_name,section,room,teacher_email";

export default function TeacherTimetable() {
  const { user } = useAuth();
  const token = useToken();

  const sections = useApiData([token], () => api.teacherSections(token));
  const [sectionChoice, setSectionChoice] = useState("");
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<TimetableUploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const teacher = user?.role === "teacher" ? user.profile : null;

  // Derived, not stored — see TeacherClasses for the reasoning.
  const sectionId = sectionChoice || sections.data?.[0]?.id || "";

  const timetable = useApiData([token, sectionId], async () => {
    if (!sectionId) return [];
    return api.sectionTimetable(token, sectionId);
  });

  if (!user || user.role !== "teacher") return null;

  const slots = timetable.data ?? [];

  const fillTemplate = () => {
    const sample = slots.slice(0, 3);
    const lines = sample.length
      ? sample.map((slot) =>
          [
            DAY_NAMES[slot.dayOfWeek].slice(0, 3),
            slot.startTime,
            slot.endTime,
            slot.subjectId,
            slot.subjectId,
            slot.sectionId,
            slot.room,
            teacher?.email ?? "",
          ].join(","),
        )
      : [`Mon,09:00,09:50,CS301,Database Management Systems,${sectionId || "CSE-3-A"},CS-Block 201,${teacher?.email ?? ""}`];
    setCsv([HEADER, ...lines].join("\n"));
    setResult(null);
    setError(null);
  };

  const upload = async () => {
    if (!sectionId) {
      setError("Choose a class first.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const outcome = await api.uploadTimetable(token, { sectionId, csv });
      setResult(outcome);
      timetable.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const byDay = new Map<number, typeof slots>();
  for (const slot of slots) {
    const list = byDay.get(slot.dayOfWeek) ?? [];
    list.push(slot);
    byDay.set(slot.dayOfWeek, list);
  }

  return (
    <PageBody>
      <PageHeader
        title="Timetable"
        description="Upload the weekly schedule for a class. Each row is one period; re-uploading a row replaces it rather than duplicating it."
        actions={<Badge tone="brand">{sectionId || "No class selected"}</Badge>}
      />

      <Card className="mb-5">
        <CardHeader title="Class" description="Only classes in your scope are listed." />
        <CardBody className="max-w-sm">
          <Field label="Class / section">
            <Select
              value={sectionId}
              onChange={(event) => setSectionChoice(event.target.value)}
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
              description="Upload a CSV on the right and it will appear here immediately."
            />
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <Th>Day</Th>
                  <Th>Period</Th>
                  <Th>Subject</Th>
                  <Th>Room</Th>
                </tr>
              </thead>
              <tbody>
                {[1, 2, 3, 4, 5, 6].flatMap((day) => {
                  const list = (byDay.get(day) ?? []).slice().sort((a, b) =>
                    a.startTime.localeCompare(b.startTime),
                  );
                  return list.map((slot, index) => (
                    <tr key={slot.id} className="hover:bg-canvas">
                      <Td className="font-medium">
                        {index === 0 ? DAY_NAMES[day].slice(0, 3) : ""}
                      </Td>
                      <Td className="tabular-nums text-muted">
                        {PERIOD_LABEL(slot.startTime, slot.endTime)}
                      </Td>
                      <Td className="font-medium">{slot.subjectId}</Td>
                      <Td className="text-muted">{slot.room}</Td>
                    </tr>
                  ));
                })}
              </tbody>
            </TableWrap>
          )}
        </Card>

        {/* Upload */}
        <Card>
          <CardHeader
            title="Upload a timetable"
            description="Comma separated. Times as 24-hour HH:MM."
            action={
              <Button variant="ghost" size="sm" onClick={fillTemplate}>
                Fill with template
              </Button>
            }
          />
          <CardBody className="flex flex-col gap-4">
            <Field
              label="CSV"
              hint="Required columns: day, start, end, subject_code, subject_name, section, room, teacher_email"
            >
              <Textarea
                value={csv}
                onChange={(event) => setCsv(event.target.value)}
                spellCheck={false}
                className="min-h-40 font-mono text-xs"
                placeholder={HEADER}
              />
            </Field>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={upload} loading={busy} disabled={!csv.trim() || !sectionId}>
                Import into {sectionId || "class"}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setCsv("");
                  setResult(null);
                  setError(null);
                }}
              >
                Clear
              </Button>
            </div>

            {error && <Alert tone="error">{error}</Alert>}

            {result && (
              <Alert
                tone={result.errors.length > 0 ? "warning" : "success"}
                title={`Imported ${result.imported} new, replaced ${result.replaced}`}
              >
                {result.errors.length === 0 ? (
                  "Every row was accepted."
                ) : (
                  <ul className="mt-1 flex flex-col gap-1">
                    {result.errors.map((message) => (
                      <li key={message}>• {message}</li>
                    ))}
                  </ul>
                )}
              </Alert>
            )}

            <div className="rounded-field bg-canvas px-3.5 py-3">
              <p className="text-xs font-medium text-ink">Why teacher_email matters</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                A period is only visible to the teacher it belongs to. Leave the column blank and
                the import tries to resolve the teacher from whoever already teaches that subject in
                that section — if nobody does, the row is rejected with the line number rather than
                silently dropped.
              </p>
            </div>
          </CardBody>
        </Card>
      </div>
    </PageBody>
  );
}
