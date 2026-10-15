import { useEffect, useState } from "react";

import { api, errorMessage } from "../../api/client";
import { PageBody, PageHeader } from "../../components/AppShell";
import { WebcamCapture } from "../../components/WebcamCapture";
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
  Modal,
  Select,
  Spinner,
  TableWrap,
  Td,
  Th,
} from "../../components/ui";
import type { ClassAttendanceRow } from "../../api/types";
import { useAuth, useToken } from "../../lib/auth";
import { isoToday } from "../../lib/format";
import { useApiData } from "../../lib/useApiData";

export default function TeacherStudents() {
  const { user } = useAuth();
  const token = useToken();
  const sections = useApiData([token], () => api.teacherSections(token));
  const [sectionId, setSectionId] = useState("");
  const roster = useApiData([token, sectionId], () => sectionId
    ? api.teacherRoster(token, { sectionId, date: isoToday() })
    : Promise.resolve([]));

  const [name, setName] = useState("");
  const [studentId, setStudentId] = useState("");
  const [email, setEmail] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [selectedStudent, setSelectedStudent] = useState<ClassAttendanceRow | null>(null);
  const [faceImage, setFaceImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!sectionId && sections.data?.[0]) setSectionId(sections.data[0].id);
  }, [sections.data, sectionId]);

  if (!user || user.role !== "teacher") return null;

  const registerStudent = async () => {
    if (!sectionId || !image) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const created = await api.teacherCreateStudent(token, {
        sectionId,
        studentId: studentId.trim(),
        name: name.trim(),
        email: email.trim(),
        image,
      });
      setNotice(`${created.name ?? name.trim()} was added to ${sectionId}; face capture is ready for attendance. Ask the student to claim the account using ${email.trim()}, roll number ${studentId.trim()}, and this class in signup.`);
      setName("");
      setStudentId("");
      setEmail("");
      setImage(null);
      roster.reload();
      sections.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveStudentFace = async () => {
    if (!selectedStudent || !faceImage) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.teacherEnrollFace(token, selectedStudent.studentId, sectionId, faceImage);
      setNotice(`${selectedStudent.name}'s face was verified and is ready for recognition.`);
      setSelectedStudent(null);
      setFaceImage(null);
      roster.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageBody>
      <PageHeader
        title="Student registration"
        description="Add a student to one of your classes and capture their face with the same YuNet + SFace embedding used by register.py."
      />

      {error && <div className="mb-5"><Alert tone="error">{error}</Alert></div>}
      {notice && <div className="mb-5"><Alert tone="success" title="Student registration updated">{notice}</Alert></div>}

      <Card className="mb-5">
        <CardHeader
          title="Add student and capture face"
          description="The student’s entered email must be verified when they claim their account. The captured photo is processed and discarded; only the numeric face embedding is stored."
        />
        <CardBody className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
          <div className="flex flex-col gap-4">
            <Field label="Class / section" required>
              <Select value={sectionId} onChange={(event) => setSectionId(event.target.value)} disabled={busy || sections.loading}>
                {(sections.data ?? []).map((section) => (
                  <option key={section.id} value={section.id}>{section.id}</option>
                ))}
              </Select>
            </Field>
            <Field label="Student name" required>
              <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoComplete="name" placeholder="Full name" />
            </Field>
            <Field label="Student email" required hint="The student must claim the account with this verified address.">
              <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} autoComplete="email" placeholder="student@gmail.com" />
            </Field>
            <Field label="Roll number" required>
              <Input value={studentId} onChange={(event) => setStudentId(event.target.value)} maxLength={64} placeholder="SAHE roll number" />
            </Field>
            <Button onClick={() => void registerStudent()} loading={busy} disabled={!sectionId || !name.trim() || !studentId.trim() || !email.trim() || !image}>
              Create student account and roster entry
            </Button>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium text-ink">Face capture</p>
            <WebcamCapture capturedImage={image} onCapture={setImage} onRetake={() => setImage(null)} disabled={busy} />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Class roster and face status"
          description="Capture missing faces or verify a saved face again. Existing student accounts keep their signup and approval status."
          action={roster.loading ? <Spinner /> : <Button variant="secondary" size="sm" onClick={roster.reload}>Refresh</Button>}
        />
        {!sectionId ? (
          <CardBody><EmptyState title="No assigned classes" description="Ask your HOD to assign you to a class before registering students." /></CardBody>
        ) : roster.error ? (
          <CardBody><Alert tone="error">{roster.error}</Alert></CardBody>
        ) : !roster.loading && !(roster.data ?? []).length ? (
          <CardBody><EmptyState title="No students in this class yet" description="Add a student using the form above, or ask students to sign up and request membership." /></CardBody>
        ) : (
          <TableWrap>
            <thead><tr><Th>Roll</Th><Th>Name</Th><Th>Membership</Th><Th>Face</Th><Th align="right">Action</Th></tr></thead>
            <tbody>
              {(roster.data ?? []).map((student) => (
                <tr key={student.studentId} className="hover:bg-canvas">
                  <Td className="font-medium tabular-nums">{student.studentId}</Td>
                  <Td>{student.name}</Td>
                  <Td><Badge tone={student.enrollmentStatus === "approved" ? "present" : student.enrollmentStatus === "pending" ? "late" : "absent"}>{student.enrollmentStatus}</Badge></Td>
                  <Td><Badge tone={student.faceEnrolled ? "present" : "late"}>{student.faceEnrolled ? "Enrolled" : "Not enrolled"}</Badge></Td>
                  <Td align="right"><Button size="sm" variant="secondary" disabled={busy} onClick={() => { setSelectedStudent(student); setFaceImage(null); setError(""); }}>{student.faceEnrolled ? "Verify face" : "Capture face"}</Button></Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <Modal
        open={Boolean(selectedStudent)}
        onClose={() => { if (!busy) { setSelectedStudent(null); setFaceImage(null); } }}
        title={selectedStudent?.faceEnrolled ? "Verify student face" : "Capture student face"}
        description={selectedStudent ? `${selectedStudent.name} · Roll ${selectedStudent.studentId}` : undefined}
        footer={<>
          <Button variant="ghost" disabled={busy} onClick={() => { setSelectedStudent(null); setFaceImage(null); }}>Cancel</Button>
          <Button loading={busy} disabled={!faceImage} onClick={() => void saveStudentFace()}>
            {selectedStudent?.faceEnrolled ? "Verify and save" : "Save face embedding"}
          </Button>
        </>}
      >
        {selectedStudent && (
          <WebcamCapture capturedImage={faceImage} onCapture={setFaceImage} onRetake={() => setFaceImage(null)} disabled={busy} />
        )}
      </Modal>
    </PageBody>
  );
}
