/* ---------------------------------------------------------------------------
   Mock implementation of the Api contract.

   This is not a pile of random data: it ENFORCES the same rules the real
   backend must enforce, so the UI is built against the real constraints:

     * a teacher only ever sees sections they are assigned to
     * an HOD sees every section in their department; a plain admin does not
     * marking attendance outside your own section is rejected
     * a department join code is required to join, and only the HOD can rotate
       it or change member permissions

   If a screen works against this mock, it already respects the permission
   model — that is the point.

   Persistence: accounts/roster/timetable/departments are mirrored into
   localStorage (a few hundred KB) so a reload does not wipe a freshly created
   account. Attendance history is regenerated deterministically and only
   teacher-made corrections are replayed on top.
--------------------------------------------------------------------------- */

import { HttpError } from "./contract";
import type {
  Api,
  DeptAnalytics,
  SectionOption,
  SignupStudentInput,
  SignupTeacherInput,
  TimetableUploadResult,
} from "./contract";
import { DEMO_PASSWORD, createSeedDatabase, toIsoDate, addDays } from "./seed";
import type { MemberRecord, MockUser, SeedDatabase } from "./seed";
import type {
  AttendanceRecord,
  AttendanceSessionState,
  AttendanceStatus,
  ClassAttendanceRow,
  Department,
  DeptMember,
  DeptPermissions,
  DeptPost,
  DeptPostKind,
  DeptReply,
  Role,
  SessionUser,
  StudentProfile,
  Subject,
  SubjectAttendanceSummary,
  TimetableChangeInput,
  TeacherProfile,
  TimetableSlot,
  TodayEntry,
} from "./types";

const STORAGE_KEY = "smart-attendance.mock.v1";

interface Persisted {
  users: MockUser[];
  students: StudentProfile[];
  teachers: TeacherProfile[];
  sections: SeedDatabase["sections"];
  subjects: Subject[];
  slots: TimetableSlot[];
  departments: Department[];
  members: MemberRecord[];
  posts: DeptPost[];
  replies?: DeptReply[];
  attendanceOverrides: AttendanceRecord[];
  timetableChanges?: SavedTimetableChange[];
  completedSessions?: string[];
}

interface SavedTimetableChange extends TimetableChangeInput {
  id: string;
  addedSlot?: TimetableSlot;
  cancelled?: boolean;
}

/** The live in-memory database: generated history + persisted mutations. */
let db: SeedDatabase;
let attendanceOverrides: AttendanceRecord[] = [];
let replies: DeptReply[] = [];
let timetableChanges: SavedTimetableChange[] = [];
let completedSessions = new Set<string>();

function attendanceSessionKey(sectionId: string, date: string, slotId: string) {
  return `${sectionId}|${date}|${slotId}`;
}

function seedCompletedSessions(): Set<string> {
  const now = new Date();
  const today = toIsoDate(now);
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return new Set(db.attendance.flatMap((record) => {
    const slot = db.slots.find((item) => item.id === record.slotId);
    if (!slot || (record.date === today && slot.endTime > currentTime) || record.date > today) return [];
    return [attendanceSessionKey(record.sectionId, record.date, record.slotId)];
  }));
}

function loadPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    // Corrupt or unavailable storage must never break the app.
    return null;
  }
}

function persist() {
  const payload: Persisted = {
    users: db.users,
    students: db.students,
    teachers: db.teachers,
    sections: db.sections,
    subjects: db.subjects,
    slots: db.slots,
    departments: db.departments,
    members: db.members,
    posts: db.posts,
    replies,
    attendanceOverrides,
    timetableChanges,
    completedSessions: [...completedSessions],
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota/private-mode failures are non-fatal for a mock.
  }
}

function init() {
  db = createSeedDatabase();
  attendanceOverrides = [];
  replies = [];
  timetableChanges = [];
  completedSessions = new Set();
  const saved = loadPersisted();
  if (saved) {
    db.users = saved.users;
    db.students = saved.students;
    db.teachers = saved.teachers;
    db.sections = saved.sections;
    db.subjects = saved.subjects;
    db.slots = saved.slots;
    db.departments = saved.departments;
    db.members = saved.members;
    db.posts = saved.posts;
    replies = saved.replies ?? [];
    attendanceOverrides = saved.attendanceOverrides ?? [];
    timetableChanges = saved.timetableChanges ?? [];
    completedSessions = new Set(saved.completedSessions ?? []);
  }
  for (const record of attendanceOverrides) {
    const index = db.attendance.findIndex((r) => r.id === record.id);
    if (index >= 0) db.attendance[index] = record;
    else db.attendance.push(record);
  }

  // Keep exactly one period per (section, weekday, start time). An earlier
  // build keyed uploaded slots on a synthesized id, so a re-upload could sit
  // beside the seeded row instead of replacing it; this collapses any such
  // duplicates that are already sitting in a reviewer's browser storage.
  const seen = new Set<string>();
  db.slots = db.slots.filter((slot) => {
    const key = `${slot.sectionId}|${slot.dayOfWeek}|${slot.startTime}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!saved?.completedSessions) completedSessions = seedCompletedSessions();
}

init();

/* ---------------------------------------------------------------- helpers */

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Simulated network latency, shaped like a local server. */
const net = () => delay(40 + Math.random() * 90);

function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}

function parseToken(token: string): string {
  if (!token || !token.startsWith("mock.")) fail(401, "Not signed in.");
  const userId = token.slice("mock.".length);
  if (!db.users.some((u) => u.id === userId)) fail(401, "Session expired.");
  return userId;
}

function currentUser(token: string): SessionUser {
  const userId = parseToken(token);
  const student = db.students.find((s) => s.userId === userId);
  if (student) return { role: "student", profile: student };
  const teacher = db.teachers.find((t) => t.userId === userId);
  if (teacher) return { role: "teacher", profile: teacher };
  fail(401, "Account no longer exists.");
}

function sectionIdOf(branch: string, year: number, section: string) {
  return `${branch}-${year}-${section}`;
}

function ensureSection(branch: string, year: number, section: string) {
  const id = sectionIdOf(branch, year, section);
  let existing = db.sections.find((s) => s.id === id);
  if (!existing) {
    existing = { id, branch, year, section, strength: 0 };
    db.sections.push(existing);
  }
  return existing;
}

function teacherName(userId: string): string {
  return db.teachers.find((t) => t.userId === userId)?.name ?? "Unassigned";
}

function sectionOptionsForTeacher(teacher: TeacherProfile): SectionOption[] {
  const visible = new Set<string>();

  if (teacher.isHod && teacher.departmentId) {
    // An HOD oversees the whole department, so every section taught by any
    // member of that department is in scope.
    for (const member of db.members) {
      if (member.departmentId !== teacher.departmentId) continue;
      const memberTeacher = db.teachers.find((t) => t.userId === member.userId);
      if (!memberTeacher) continue;
      for (const a of memberTeacher.assignments) visible.add(a.sectionId);
    }
  }
  for (const a of teacher.assignments) visible.add(a.sectionId);

  return db.sections
    .filter((s) => visible.has(s.id))
    .map((s) => ({
      id: s.id,
      branch: s.branch,
      year: s.year,
      section: s.section,
      strength: db.students.filter((st) => st.sectionId === s.id).length || s.strength,
    }));
}

function assertSectionInScope(token: string, sectionId: string) {
  const user = currentUser(token);
  if (user.role !== "teacher") fail(403, "Only teachers can do that.");
  const allowed = sectionOptionsForTeacher(user.profile).map((s) => s.id);
  if (!allowed.includes(sectionId)) {
    fail(403, "You are not assigned to that class.");
  }
  return user.profile;
}

function effectiveSchedule(sectionId: string, date: string): TimetableSlot[] {
  const dayOfWeek = new Date(`${date}T00:00:00`).getDay();
  const changes = timetableChanges.filter((change) => change.sectionId === sectionId && change.date === date);
  const result = db.slots
    .filter((slot) => slot.sectionId === sectionId && slot.dayOfWeek === dayOfWeek)
    .flatMap((slot) => {
      const change = changes.find((item) => item.slotId === slot.id && item.kind !== "add");
      if (change?.kind === "cancel") return [];
      if (change?.kind === "modify") {
        return [{
          ...slot,
          startTime: change.startTime ?? slot.startTime,
          endTime: change.endTime ?? slot.endTime,
          room: change.room ?? slot.room,
          dateChange: "modified" as const,
        }];
      }
      return [slot];
    });
  result.push(...changes.flatMap((change) => change.kind === "add" && !change.cancelled && change.addedSlot ? [
    { ...change.addedSlot, dateChange: "added" as const },
  ] : []));
  return result.sort((left, right) => left.startTime.localeCompare(right.startTime));
}

/** Narrow a stored membership down to the public shape the API exposes. */
function publicMember(member: MemberRecord): DeptMember {
  return {
    userId: member.userId,
    name: member.name,
    email: member.email,
    role: member.role,
    joinedAt: member.joinedAt,
    permissions: member.permissions,
    assignedSections: member.assignedSections,
  };
}

function postFor(postId: string): DeptPost {
  const post = db.posts.find((p) => p.id === postId);
  if (!post) fail(404, "Post not found.");
  return post;
}

function generateJoinCode(name: string, deptId: string): string {
  const prefix = name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "DEP";
  let code = "";
  do {
    const a = Math.random().toString(36).slice(2, 6).toUpperCase();
    const b = Math.random().toString(36).slice(2, 6).toUpperCase();
    code = `${prefix}-${a}-${b}`;
  } while (db.departments.some((d) => d.id !== deptId && d.joinCode === code));
  return code;
}

/**
 * Parse a timetable time into a canonical HH:MM, or null if it is not a real
 * clock time. Without the range check, "25:99" looks well-formed to a naive
 * pattern match and would sail straight into the published grid.
 */
function parseTime(value: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim().replace(".", ":"));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function refreshMemberCounts() {
  for (const dept of db.departments) {
    dept.memberCount = db.members.filter((m) => m.departmentId === dept.id).length;
  }
}

/* -------------------------------------------------------------------- API */

export const mockApi: Api = {
  /* ------------------------------------------------------------------ auth */

  async login(email, password) {
    await net();
    const user = db.users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase());
    if (!user) fail(401, "No account found for that email.");
    if (user.password !== password) fail(401, "Incorrect password.");
    const token = `mock.${user.id}`;
    return { token, user: currentUser(token) };
  },

  async signupStudent(input: SignupStudentInput) {
    await net();
    if (input.password.length < 8) fail(400, "Password must be at least 8 characters.");
    if (db.users.some((u) => u.email.toLowerCase() === input.email.toLowerCase())) {
      fail(409, "That email is already registered.");
    }
    const userId = `u-${input.studentId}`;
    const section = ensureSection(input.branch, input.year, input.section);
    const existingProfile = db.students.find((s) => s.studentId === input.studentId);
    const existingAccount = existingProfile && db.users.find((user) => user.id === existingProfile.userId);
    if (existingProfile && existingAccount?.claimableStudent) {
      if (existingAccount.claimEmail?.toLowerCase() !== input.email.toLowerCase()) {
        fail(403, "Use the email address entered by your teacher for this student record.");
      }
      if (existingProfile.sectionId !== section.id) fail(409, "The class details must match the student record created by their teacher.");
      existingAccount.email = input.email;
      existingAccount.password = input.password;
      existingAccount.claimableStudent = false;
      existingAccount.claimEmail = undefined;
      Object.assign(existingProfile, { name: input.name, email: input.email });
      persist();
      return { token: `mock.${existingAccount.id}`, user: { role: "student", profile: existingProfile } };
    }
    if (existingProfile) fail(409, `Roll number ${input.studentId} is already registered.`);
    db.users.push({ id: userId, email: input.email, password: input.password, role: "student" });

    const profile: StudentProfile = {
      studentId: input.studentId,
      userId,
      name: input.name,
      email: input.email,
      branch: input.branch,
      year: input.year,
      section: input.section,
      sectionId: section.id,
      faceEnrolled: false,

      harvestedReferences: 0,
      joinedAt: toIsoDate(new Date()),
      enrollmentStatus: "approved",
    };
    db.students.push(profile);
    persist();
    return { token: `mock.${userId}`, user: { role: "student", profile } };
  },

  async signupTeacher(input: SignupTeacherInput) {
    await net();
    if (input.password.length < 8) fail(400, "Password must be at least 8 characters.");
    if (db.users.some((u) => u.email.toLowerCase() === input.email.toLowerCase())) {
      fail(409, "That email is already registered.");
    }

    const userId = `u-t${db.users.length}-${Date.now().toString(36)}`;
    for (const a of input.assignments) ensureSection(a.branch, a.year, a.section);

    const profile: TeacherProfile = {
      userId,
      name: input.name,
      email: input.email,
      // A new teacher is deliberately NOT in a department: they must either
      // create one (becoming HOD) or join an existing one with a code.
      departmentId: null,
      departmentName: null,
      isHod: false,
      assignments: input.assignments.map((a, index) => ({
        id: `asg-${userId}-${index}`,
        subjectId: a.subjectCode,
        subjectCode: a.subjectCode,
        subjectName: a.subjectName,
        sectionId: sectionIdOf(a.branch, a.year, a.section),
        branch: a.branch,
        year: a.year,
        section: a.section,
        periodsPerWeek: db.slots.filter(
          (s) => s.sectionId === sectionIdOf(a.branch, a.year, a.section) && s.subjectId === a.subjectCode,
        ).length,
      })),
    };

    db.users.push({ id: userId, email: input.email, password: input.password, role: "teacher" });
    db.teachers.push(profile);
    persist();
    return { token: `mock.${userId}`, user: { role: "teacher", profile } };
  },

  async me(token) {
    await delay(20);
    return currentUser(token);
  },

  async logout() {
    await delay(20);
  },

  /* -------------------------------------------------------------- directory */

  async listSections() {
    await net();
    return db.sections.map((s) => ({
      id: s.id,
      branch: s.branch,
      year: s.year,
      section: s.section,
      strength: db.students.filter((st) => st.sectionId === s.id).length || s.strength,
    }));
  },

  async listDepartments() {
    await net();
    refreshMemberCounts();
    return db.departments.map((d) => ({ ...d }));
  },

  /* ----------------------------------------------------------------- student */

  async studentSummary(token) {
    await net();
    const user = currentUser(token);
    if (user.role !== "student") fail(403, "Students only.");

    const summaries = new Map<string, SubjectAttendanceSummary>();
    for (const record of db.attendance) {
      if (record.studentId !== user.profile.studentId) continue;
      if (!completedSessions.has(attendanceSessionKey(record.sectionId, record.date, record.slotId))) continue;
      const subject = db.subjects.find((s) => s.id === record.subjectId);
      const key = record.subjectId;
      if (!summaries.has(key)) {
        summaries.set(key, {
          subjectId: key,
          subjectCode: subject?.code ?? key,
          subjectName: subject?.name ?? key,
          heldCount: 0,
          presentCount: 0,
          absentCount: 0,
          lateCount: 0,
          excusedCount: 0,
          percentage: null,
        });
      }
      const summary = summaries.get(key)!;
      summary.heldCount += 1;
      if (record.status === "present") summary.presentCount += 1;
      else if (record.status === "late") summary.lateCount += 1;
      else if (record.status === "absent") summary.absentCount += 1;
      else if (record.status === "excused") summary.excusedCount += 1;
    }

    for (const summary of summaries.values()) {
      // Percentage counts present + late as attended. "Excused" is shown
      // separately and left out of BOTH sides of the ratio, because an
      // authorised absence should not silently count as attendance.
      const counted = summary.presentCount + summary.lateCount;
      const denominator = summary.heldCount - summary.excusedCount;
      summary.percentage = denominator > 0 ? (counted / denominator) * 100 : null;
    }

    return [...summaries.values()].sort((a, b) => a.subjectCode.localeCompare(b.subjectCode));
  },

  async studentSchedule(token, date) {
    await net();
    const user = currentUser(token);
    if (user.role !== "student") fail(403, "Students only.");

    const daySlots = effectiveSchedule(user.profile.sectionId, date);

    return daySlots.map<TodayEntry>((slot) => {
      const record =
        db.attendance.find(
          (r) => r.slotId === slot.id && r.date === date && r.studentId === user.profile.studentId,
        ) ?? null;
      const subject =
        db.subjects.find((s) => s.id === slot.subjectId) ??
        ({ id: slot.subjectId, code: slot.subjectId, name: slot.subjectId, branch: "", year: 0 } as Subject);
      return {
        slot,
        subject,
        teacherName: teacherName(slot.teacherId),
        record,
        status: record?.status ?? "unmarked",
      };
    });
  },

  async studentAttendance(token, from, to) {
    await net();
    const user = currentUser(token);
    if (user.role !== "student") fail(403, "Students only.");
    return db.attendance
      .filter(
        (r) => r.studentId === user.profile.studentId && r.date >= from && r.date <= to
          && (!r.slotId || completedSessions.has(attendanceSessionKey(r.sectionId, r.date, r.slotId))),
      )
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.slotId.localeCompare(a.slotId)));
  },

  async enrollFace(token, imageDataUrl) {
    // The real endpoint runs YuNet + SFace on this frame; keep the same shape
    // of failure so the UI's error path is exercised honestly.
    await delay(1400);
    const user = currentUser(token);
    if (user.role !== "student") fail(403, "Students only.");
    if (!imageDataUrl.startsWith("data:image/")) fail(400, "No image was supplied.");
    if (imageDataUrl.length < 4000) fail(422, "No usable face detected in the frame. Face the camera and try again.");

    const index = db.students.findIndex((s) => s.studentId === user.profile.studentId);
    if (index < 0) fail(404, "Student record missing.");
    db.students[index] = { ...db.students[index], faceEnrolled: true, harvestedReferences: 0 };
    persist();
    return { harvestedReferences: 0 };
  },

  /* ----------------------------------------------------------------- teacher */

  async teacherSections(token) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    return sectionOptionsForTeacher(user.profile);
  },

  async teacherRoster(token, params) {
    await net();
    assertSectionInScope(token, params.sectionId);
    const cancelled = timetableChanges.some((change) =>
      change.date === params.date && change.sectionId === params.sectionId
      && change.slotId === params.slotId
      && (change.kind === "cancel" || (change.kind === "add" && change.cancelled)),
    );
    if (cancelled) fail(409, "This period was cancelled for that date.");

    const roster = db.students.filter((s) => s.sectionId === params.sectionId);
    const daySlots = effectiveSchedule(params.sectionId, params.date);

    const relevant = params.slotId
      ? daySlots.filter((s) => s.id === params.slotId)
      : daySlots;
    if (params.slotId && relevant.length === 0) fail(404, "Period is not scheduled for that class and date.");
    const slotIds = new Set(relevant.map((s) => s.id));

    return roster
      .map<ClassAttendanceRow>((student) => {
        const records = db.attendance.filter(
          (r) =>
            r.studentId === student.studentId &&
            r.date === params.date &&
            slotIds.has(r.slotId),
        );

        if (records.length === 0) {
          return {
            studentId: student.studentId,
            name: student.name,
            faceEnrolled: student.faceEnrolled,
            status: "unmarked",
            inTime: null,
            method: null,
            enrollmentStatus: student.enrollmentStatus ?? "approved",
          };
        }

        const best =
          records.find((r) => r.status === "present") ??
          records.find((r) => r.status === "late") ??
          records.find((r) => r.status === "excused") ??
          records[0];
        return {
          studentId: student.studentId,
          name: student.name,
          faceEnrolled: student.faceEnrolled,
          status: best.status,
          inTime: best.inTime,
          method: best.method,
          enrollmentStatus: student.enrollmentStatus ?? "approved",
        };
      })
      .sort((a, b) => a.studentId.localeCompare(b.studentId));
  },

  async reviewStudent(token, studentId, sectionId, status) {
    await net();
    assertSectionInScope(token, sectionId);
    const student = db.students.find((item) => item.studentId === studentId && item.sectionId === sectionId);
    if (!student) fail(404, "Student class request was not found.");
    student.enrollmentStatus = status;
    persist();
  },

  async teacherCreateStudent(token, input) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    assertSectionInScope(token, input.sectionId);
    if (!input.image.startsWith("data:image/") || input.image.length < 4000) fail(422, "Capture a clear face photo first.");
    if (db.students.some((student) => student.studentId === input.studentId)) fail(409, "That roll number already exists in this demo.");
    if (db.users.some((account) => account.email.toLowerCase() === input.email.toLowerCase())) fail(409, "An account already uses that email address.");
    const section = db.sections.find((item) => item.id === input.sectionId);
    if (!section) fail(404, "Class section was not found.");
    const userId = `claim-${input.studentId}-${Date.now()}`;
    const profile: StudentProfile = {
      studentId: input.studentId,
      userId,
      name: input.name,
      email: input.email,
      branch: section.branch,
      year: section.year,
      section: section.section,
      sectionId: section.id,
      faceEnrolled: true,
      harvestedReferences: 0,
      joinedAt: toIsoDate(new Date()),
      enrollmentStatus: "approved",
    };
    db.users.push({ id: userId, email: `claim-${userId}@pending.invalid`, password: `unusable-${Date.now()}`, role: "student", claimableStudent: true, claimEmail: input.email });
    db.students.push(profile);
    section.strength += 1;
    persist();
    return { studentId: profile.studentId, accountStatus: "awaiting_student_claim" };
  },

  async teacherEnrollFace(token, studentId, sectionId, image) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    assertSectionInScope(token, sectionId);
    if (!image.startsWith("data:image/") || image.length < 4000) fail(422, "Capture a clear face photo first.");
    const student = db.students.find((item) => item.studentId === studentId && item.sectionId === sectionId);
    if (!student) fail(404, "Student is not on this class roster.");
    student.faceEnrolled = true;
    student.harvestedReferences = 0;
    persist();
    return { faceEnrolled: true };
  },

  async markAttendance(token, input) {
    await net();
    assertSectionInScope(token, input.sectionId);
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    if (input.date > toIsoDate(new Date())) fail(422, "Attendance cannot be marked for a future date.");
    if (timetableChanges.some((change) => change.date === input.date && change.slotId === input.slotId
      && (change.kind === "cancel" || (change.kind === "add" && change.cancelled)))) {
      fail(409, "This period was cancelled for that date.");
    }
    const userId = user.profile.userId;

    const id = `att-${input.date}-${input.slotId}-${input.studentId}`;
    const scheduledSlot = effectiveSchedule(input.sectionId, input.date).find((s) => s.id === input.slotId);
    if (!scheduledSlot) fail(404, "Period not found for that date.");
    if (scheduledSlot.teacherId !== user.profile.userId) fail(403, "Only the teacher scheduled for this period can mark attendance.");
    const student = db.students.find((item) => item.studentId === input.studentId && item.sectionId === input.sectionId);
    if (!student) fail(404, "Student is not in this class.");
    if (student.enrollmentStatus !== "approved") fail(409, "Approve the student's class membership before marking attendance.");
    const record: AttendanceRecord = {
      id,
      studentId: input.studentId,
      subjectId: scheduledSlot.subjectId,
      slotId: input.slotId,
      sectionId: input.sectionId,
      date: input.date,
      status: input.status,
      inTime:
        input.status === "present"
          ? new Date().toTimeString().slice(0, 8)
          : input.status === "late"
            ? new Date().toTimeString().slice(0, 8)
            : null,
      outTime: null,
      method: "manual",
      markedBy: userId,
    };

    const index = db.attendance.findIndex((r) => r.id === id);
    if (index >= 0) db.attendance[index] = record;
    else db.attendance.push(record);

    const overrideIndex = attendanceOverrides.findIndex((r) => r.id === id);
    if (overrideIndex >= 0) attendanceOverrides[overrideIndex] = record;
    else attendanceOverrides.push(record);

    persist();
    return record;
  },

  async attendanceSession(token, params): Promise<AttendanceSessionState> {
    await net();
    assertSectionInScope(token, params.sectionId);
    const scheduled = effectiveSchedule(params.sectionId, params.date)
      .some((slot) => slot.id === params.slotId);
    if (!scheduled) fail(404, "Period is not scheduled for that class and date.");
    return {
      completed: completedSessions.has(attendanceSessionKey(params.sectionId, params.date, params.slotId)),
      completedAt: null,
      cameraSession: false,
    };
  },

  async completeAttendanceSession(token, input) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    assertSectionInScope(token, input.sectionId);
    if (input.date > toIsoDate(new Date())) fail(422, "A future period cannot be completed.");
    const scheduled = effectiveSchedule(input.sectionId, input.date)
      .find((slot) => slot.id === input.slotId);
    if (!scheduled) fail(404, "Period is not scheduled for that class and date.");
    if (scheduled.teacherId !== user.profile.userId) fail(403, "Only the teacher scheduled for this period can complete attendance.");
    const key = attendanceSessionKey(input.sectionId, input.date, input.slotId);
    if (completedSessions.has(key)) return { completed: true, completedAt: null, absencesAdded: 0, reviewRequired: 0 };

    let absencesAdded = 0;
    for (const student of db.students.filter((item) =>
      item.sectionId === input.sectionId && item.enrollmentStatus === "approved",
    )) {
      const id = `att-${input.date}-${input.slotId}-${student.studentId}`;
      if (db.attendance.some((record) => record.id === id)) continue;
      const absence: AttendanceRecord = {
        id,
        studentId: student.studentId,
        subjectId: scheduled.subjectId,
        slotId: input.slotId,
        sectionId: input.sectionId,
        date: input.date,
        status: "absent",
        inTime: null,
        outTime: null,
        method: "manual",
        markedBy: user.profile.userId,
      };
      db.attendance.push(absence);
      attendanceOverrides.push(absence);
      absencesAdded += 1;
    }
    completedSessions.add(key);
    persist();
    return { completed: true, completedAt: null, absencesAdded, reviewRequired: 0 };
  },

  async teacherSchedule(token, date) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");

    if (user.profile.isHod && user.profile.departmentId) {
      const deptSections = new Set(
        sectionOptionsForTeacher(user.profile).map((s) => s.id),
      );
      return [...deptSections].flatMap((sectionId) => effectiveSchedule(sectionId, date))
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
    }

    return [...new Set(user.profile.assignments.map((assignment) => assignment.sectionId))]
      .flatMap((sectionId) => effectiveSchedule(sectionId, date))
      .filter((slot) => slot.teacherId === user.profile.userId)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  },

  async sectionTimetable(token, sectionId, date) {
    await net();
    const user = currentUser(token);
    if (user.role === "student") {
      // A student may read their own class timetable and nothing else.
      if (user.profile.sectionId !== sectionId) {
        fail(403, "You can only view your own class timetable.");
      }
    } else {
      assertSectionInScope(token, sectionId);
    }
    if (date) return effectiveSchedule(sectionId, date);
    return db.slots.filter((s) => s.sectionId === sectionId).sort((a, b) =>
      a.dayOfWeek === b.dayOfWeek
        ? a.startTime.localeCompare(b.startTime)
        : a.dayOfWeek - b.dayOfWeek,
    );
  },

  async previewTimetableChange(token, input) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    assertSectionInScope(token, input.sectionId);
    if (!user.profile.assignments.some((a) => a.sectionId === input.sectionId)) {
      fail(403, "You can only change a class you are assigned to teach.");
    }
    if (input.date < new Date().toISOString().slice(0, 10)) {
      fail(422, "Timetable changes can only be published for today or a future date.");
    }
    const dayOfWeek = new Date(`${input.date}T00:00:00`).getDay();
    if (dayOfWeek === 0) fail(422, "Timetable changes are only available Monday through Saturday.");
    const existingChange = timetableChanges.find((change) =>
      change.date === input.date && change.slotId === input.slotId,
    );
    const cancellingExtra = input.kind === "cancel" && existingChange?.kind === "add";
    if (cancellingExtra && existingChange?.cancelled) {
      fail(409, "This extra period has already been cancelled.");
    }
    let slot: TimetableSlot;
    if (input.kind === "cancel" || input.kind === "modify") {
      const recurring = db.slots.find((s) => s.id === input.slotId && s.sectionId === input.sectionId && s.dayOfWeek === dayOfWeek);
      const base = cancellingExtra ? existingChange?.addedSlot : recurring;
      if (!base) fail(404, "That recurring period is not on the selected date.");
      if (existingChange?.kind === "add" && input.kind !== "cancel") {
        fail(404, "Only an extra period can be cancelled, not edited as a recurring period.");
      }
      if (!user.profile.assignments.some((a) => a.sectionId === input.sectionId && a.subjectId === base.subjectId)) {
        fail(403, "You can only change a period for a subject you are assigned to teach.");
      }
      slot = input.kind === "modify"
        ? {
            ...base,
            startTime: parseTime(input.startTime ?? "") ?? base.startTime,
            endTime: parseTime(input.endTime ?? "") ?? base.endTime,
            room: input.room ?? base.room,
            dateChange: "modified",
          }
        : base;
    } else {
      const assignment = user.profile.assignments.find((a) =>
        a.sectionId === input.sectionId && a.subjectId === input.subjectId,
      );
      if (!assignment) fail(403, "Choose a subject assigned to you for this class.");
      const startTime = parseTime(input.startTime ?? "");
      const endTime = parseTime(input.endTime ?? "");
      if (!startTime || !endTime || endTime <= startTime) fail(422, "Enter a valid start and end time in 24-hour HH:MM format.");
      slot = {
        id: `preview-${input.date}-${input.sectionId}-${startTime}`,
        sectionId: input.sectionId,
        subjectId: assignment.subjectId,
        teacherId: user.profile.userId,
        dayOfWeek,
        startTime,
        endTime,
        room: input.room ?? "",
        dateChange: "added",
      };
      const reservedStart = db.slots.some((item) =>
        item.sectionId === input.sectionId && item.dayOfWeek === dayOfWeek && item.startTime === startTime,
      ) || timetableChanges.some((change) =>
        change.sectionId === input.sectionId && change.addedSlot?.dayOfWeek === dayOfWeek
        && change.addedSlot.startTime === startTime,
      );
      if (reservedStart) {
        fail(409, "That start time is already reserved by a recurring or previously used period. Choose another start time.");
      }
    }
    if (input.kind !== "cancel") {
      const others = effectiveSchedule(input.sectionId, input.date).filter((item) => item.id !== input.slotId);
      const conflict = others.find((item) =>
        slot.startTime < item.endTime && slot.endTime > item.startTime,
      );
      if (conflict) fail(409, `This change overlaps another period (${conflict.startTime}–${conflict.endTime}).`);
      for (const sectionId of new Set(user.profile.assignments.map((a) => a.sectionId))) {
        if (sectionId === input.sectionId) continue;
        const teacherConflict = effectiveSchedule(sectionId, input.date).find((item) =>
          item.teacherId === user.profile.userId
          && slot.startTime < item.endTime && slot.endTime > item.startTime,
        );
        if (teacherConflict) fail(409, `This change conflicts with your other class (${sectionId}, ${teacherConflict.startTime}–${teacherConflict.endTime}).`);
      }
    }
    return { kind: input.kind, date: input.date, slot };
  },

  async createTimetableChange(token, input) {
    await net();
    const preview = await this.previewTimetableChange(token, input);
    const id = `change-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const existing = timetableChanges.find((change) =>
      change.date === input.date && change.slotId === input.slotId,
    );
    if (input.kind === "cancel" && existing?.kind === "add") {
      existing.cancelled = true;
      persist();
      return { message: "Extra period cancelled for this date." };
    }
    const addedSlot = input.kind === "add"
      ? { ...preview.slot, id: `slot-${id}` }
      : undefined;
    const nextChange: SavedTimetableChange = {
      ...input,
      id: existing?.id ?? id,
      slotId: input.kind === "add" ? addedSlot?.id : input.slotId,
      addedSlot: existing?.addedSlot ?? addedSlot,
      cancelled: false,
    };
    if (existing && existing.kind !== "add") Object.assign(existing, nextChange);
    else timetableChanges.push(nextChange);
    persist();
    return { message: "Date-specific timetable change published." };
  },

  async uploadTimetable(token, input) {
    await net();
    assertSectionInScope(token, input.sectionId);

    const result: TimetableUploadResult = { imported: 0, replaced: 0, errors: [] };
    const lines = input.csv
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      result.errors.push("The file is empty.");
      return result;
    }

    const header = lines[0].toLowerCase();
    if (!header.includes("day") || !header.includes("start") || !header.includes("subject")) {
      result.errors.push(
        "Header must contain at least: day,start,end,subject_code,subject_name,section,room,teacher_email",
      );
      return result;
    }
    const columns = lines[0].split(",").map((c) => c.trim().toLowerCase());
    const col = (name: string) => columns.indexOf(name);

    const DAYS: Record<string, number> = {
      mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3,
      thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
    };

    for (let i = 1; i < lines.length; i += 1) {
      const cells = lines[i].split(",").map((c) => c.trim());
      const get = (name: string) => {
        const index = col(name);
        return index >= 0 ? (cells[index] ?? "") : "";
      };
      const lineNo = i + 1;

      const dayKey = get("day").toLowerCase().slice(0, 3);
      const dayOfWeek = DAYS[dayKey];
      if (!dayOfWeek) {
        result.errors.push(`Line ${lineNo}: unrecognised day "${get("day")}".`);
        continue;
      }

      const startTime = parseTime(get("start"));
      const endTime = parseTime(get("end"));
      if (!startTime || !endTime) {
        result.errors.push(
          `Line ${lineNo}: "${get("start")}" to "${get("end")}" is not a real clock time. Use 24-hour HH:MM, e.g. 10:00.`,
        );
        continue;
      }
      if (endTime <= startTime) {
        result.errors.push(`Line ${lineNo}: the end time must be after the start time.`);
        continue;
      }

      const sectionId = get("section") || input.sectionId;
      if (sectionId !== input.sectionId) {
        result.errors.push(
          `Line ${lineNo}: section "${sectionId}" is not the class you are editing (${input.sectionId}).`,
        );
        continue;
      }

      const subjectCode = get("subject_code") || get("subject");
      if (!subjectCode) {
        result.errors.push(`Line ${lineNo}: missing subject_code.`);
        continue;
      }

      const teacherEmail = get("teacher_email");
      const teacher = teacherEmail
        ? db.teachers.find((t) => t.email.toLowerCase() === teacherEmail.toLowerCase())
        : db.teachers.find((t) => t.assignments.some((a) => a.sectionId === sectionId && a.subjectId === subjectCode));
      if (!teacher) {
        result.errors.push(
          `Line ${lineNo}: no teacher found for ${teacherEmail || subjectCode}. Add the teacher first, or leave teacher_email blank and assign the subject.`,
        );
        continue;
      }

      // Keep the subject catalogue in sync with whatever the file mentions.
      if (!db.subjects.some((s) => s.id === subjectCode)) {
        const [branch, year] = sectionId.split("-");
        db.subjects.push({
          id: subjectCode,
          code: subjectCode,
          name: get("subject_name") || subjectCode,
          branch,
          year: Number(year) || 1,
        });
      }

      // Match on POSITION, not on a synthesized id. Seeded rows and uploaded
      // rows were created by different code paths, so keying on the id alone
      // would let a re-upload add a second row next to the original instead of
      // replacing it — which is how a timetable ends up with every period
      // listed twice.
      const existing = db.slots.find(
        (slot) =>
          slot.sectionId === sectionId &&
          slot.dayOfWeek === dayOfWeek &&
          slot.startTime === startTime,
      );

      if (existing) {
        existing.subjectId = subjectCode;
        existing.teacherId = teacher.userId;
        existing.endTime = endTime;
        existing.room = get("room") || existing.room;
        result.replaced += 1;
      } else {
        const slot: TimetableSlot = {
          id: `slot-${sectionId}-${dayOfWeek}-${startTime}`,
          sectionId,
          subjectId: subjectCode,
          teacherId: teacher.userId,
          dayOfWeek,
          startTime,
          endTime,
          room: get("room") || "TBD",
        };
        db.slots.push(slot);
        result.imported += 1;
      }
    }

    persist();
    return result;
  },

  async previewTimetable(token, input) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    const section = sectionOptionsForTeacher(user.profile).find((item) => item.id === input.sectionId);
    if (!section) fail(403, "That class is outside your teaching assignments.");
    const lines = input.csv.trim().split(/\r?\n/).slice(1).filter(Boolean);
    if (!lines.length) return { imported: 0, replaced: 0, errors: ["Add at least one timetable row."] };
    return { imported: lines.length, replaced: 0, errors: [] };
  },

  /* -------------------------------------------------------------- department */

  async myDepartment(token) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") return null;
    refreshMemberCounts();
    const dept = db.departments.find((d) => d.id === user.profile.departmentId);
    return dept ? { ...dept } : null;
  },

  async createDepartment(token, name) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    if (user.profile.departmentId) fail(409, "You already belong to a department.");
    if (!name.trim()) fail(400, "Give the department a name.");

    const dept: Department = {
      id: `dept-${Date.now().toString(36)}`,
      name: name.trim(),
      joinCode: "",
      hodUserId: user.profile.userId,
      hodName: user.profile.name,
      createdAt: toIsoDate(new Date()),
      memberCount: 1,
    };
    dept.joinCode = generateJoinCode(dept.name, dept.id);
    db.departments.push(dept);

    const index = db.teachers.findIndex((t) => t.userId === user.profile.userId);
    db.teachers[index] = {
      ...db.teachers[index],
      departmentId: dept.id,
      departmentName: dept.name,
      isHod: true,
    };

    db.members.push({
      userId: user.profile.userId,
      name: user.profile.name,
      email: user.profile.email,
      departmentId: dept.id,
      role: "hod",
      joinedAt: toIsoDate(new Date()),
      permissions: {
        manageTimetable: true,
        markAttendance: true,
        enrollStudents: true,
        postAnnouncements: true,
        viewAnalytics: true,
      },
      assignedSections: db.teachers[index].assignments.map((a) => a.sectionId),
    });

    persist();
    return { ...dept };
  },

  async joinDepartment(token, code) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    if (user.profile.departmentId) fail(409, "Leave your current department first.");

    const dept = db.departments.find(
      (d) => d.joinCode.toUpperCase().replace(/\s/g, "") === code.trim().toUpperCase().replace(/\s/g, ""),
    );
    if (!dept) fail(404, "No department matches that code. Check it with your HOD.");

    const index = db.teachers.findIndex((t) => t.userId === user.profile.userId);
    db.teachers[index] = { ...db.teachers[index], departmentId: dept.id, departmentName: dept.name };

    db.members.push({
      userId: user.profile.userId,
      name: user.profile.name,
      email: user.profile.email,
      departmentId: dept.id,
      role: "admin",
      joinedAt: toIsoDate(new Date()),
      permissions: {
        manageTimetable: true,
        markAttendance: true,
        enrollStudents: true,
        postAnnouncements: true,
        viewAnalytics: true,
      },
      assignedSections: db.teachers[index].assignments.map((a) => a.sectionId),
    });

    refreshMemberCounts();
    persist();
    return { ...dept };
  },

  async rotateDeptCode(token) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    const dept = db.departments.find((d) => d.id === user.profile.departmentId);
    if (!dept) fail(404, "You are not in a department.");
    if (!user.profile.isHod) fail(403, "Only the HOD can rotate the department code.");
    dept.joinCode = generateJoinCode(dept.name, dept.id);
    persist();
    return { ...dept };
  },

  async deptMembers(token) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    if (!user.profile.departmentId) return [];
    return db.members
      .filter((m) => m.departmentId === user.profile.departmentId)
      .map(publicMember)
      .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "hod" ? -1 : 1));
  },

  async setMemberPermissions(token, userId, permissions: DeptPermissions) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    if (!user.profile.isHod) fail(403, "Only the HOD can change access.");
    const index = db.members.findIndex(
      (m) => m.userId === userId && m.departmentId === user.profile.departmentId,
    );
    if (index < 0) fail(404, "That person is not in your department.");
    if (db.members[index].role === "hod") fail(400, "The HOD's own access cannot be reduced.");
    db.members[index] = { ...db.members[index], permissions: { ...permissions } };
    persist();
    return { ...db.members[index] };
  },

  async deptPosts(token) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    if (!user.profile.departmentId) return [];
    return db.posts
      .filter((p) => p.deptId === user.profile.departmentId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  },

  async deptReplies(token, postId) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    const post = postFor(postId);
    if (post.deptId !== user.profile.departmentId) fail(404, "Discussion not found.");
    return replies.filter((reply) => reply.postId === postId).map((reply) => ({ ...reply }));
  },

  async createDeptReply(token, postId, body) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    const post = postFor(postId);
    if (post.deptId !== user.profile.departmentId) fail(404, "Discussion not found.");
    if (!body.trim()) fail(400, "Write a reply first.");
    const reply: DeptReply = {
      id: `reply-${Date.now().toString(36)}`,
      postId,
      authorUserId: user.profile.userId,
      authorName: user.profile.name,
      body: body.trim(),
      createdAt: new Date().toISOString(),
    };
    replies.push(reply);
    persist();
    return { ...reply };
  },

  async createDeptPost(token, input) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    if (!user.profile.departmentId) fail(400, "Join a department first.");
    const member = db.members.find((m) => m.userId === user.profile.userId);
    if (input.kind === "announcement" && member && !member.permissions.postAnnouncements) {
      fail(403, "Your HOD has not given you permission to post announcements.");
    }
    if (!input.title.trim()) fail(400, "Add a title.");

    const post: DeptPost = {
      id: `post-${Date.now().toString(36)}`,
      deptId: user.profile.departmentId,
      authorUserId: user.profile.userId,
      authorName: user.profile.name,
      kind: input.kind as DeptPostKind,
      title: input.title.trim(),
      body: input.body.trim(),
      createdAt: new Date().toISOString(),
      status: "open",
      claimedByUserId: null,
      claimedByName: null,
      relatedSlotId: input.relatedSlotId ?? null,
      relatedDate: input.relatedDate ?? null,
    };
    db.posts.push(post);
    persist();
    return { ...post };
  },

  async claimDeptPost(token, postId) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    const post = postFor(postId);
    if (post.deptId !== user.profile.departmentId) fail(403, "Not your department.");
    if (post.status === "resolved") fail(409, "That request is already resolved.");
    post.claimedByUserId = user.profile.userId;
    post.claimedByName = user.profile.name;
    persist();
    return { ...post };
  },

  async resolveDeptPost(token, postId) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    const post = postFor(postId);
    if (post.deptId !== user.profile.departmentId) fail(403, "Not your department.");
    if (post.authorUserId !== user.profile.userId && !user.profile.isHod) {
      fail(403, "Only the author or the HOD can resolve this.");
    }
    post.status = "resolved";
    persist();
    return { ...post };
  },

  async deptAnalytics(token) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    const member = db.members.find((m) => m.userId === user.profile.userId);
    const sections = sectionOptionsForTeacher(user.profile);
    const scoped = member?.permissions.viewAnalytics === false ? [] : sections;

    const rows: DeptAnalytics[] = [];
    for (const section of scoped) {
      const studentsInSection = db.students.filter((s) => s.sectionId === section.id);
      const subjectIds = new Set(
        db.slots.filter((s) => s.sectionId === section.id).map((s) => s.subjectId),
      );
      for (const subjectId of subjectIds) {
        const records = db.attendance.filter(
          (r) => r.sectionId === section.id && r.subjectId === subjectId
            && completedSessions.has(attendanceSessionKey(r.sectionId, r.date, r.slotId)),
        );
        const sessionKeys = new Set(records.map((r) => `${r.date}|${r.slotId}`));
        let counted = 0;
        let attended = 0;
        let atRisk = 0;
        for (const student of studentsInSection) {
          const own = records.filter((r) => r.studentId === student.studentId);
          const present = own.filter((r) => r.status === "present" || r.status === "late").length;
          const excused = own.filter((r) => r.status === "excused").length;
          const denominator = own.length - excused;
          counted += denominator;
          attended += present;
          if (denominator > 0 && present / denominator < 0.75) atRisk += 1;
        }
        const subject = db.subjects.find((s) => s.id === subjectId);
        rows.push({
          sectionId: section.id,
          subjectCode: subject?.code ?? subjectId,
          subjectName: subject?.name ?? subjectId,
          sessionsHeld: sessionKeys.size,
          presentRate: counted > 0 ? (attended / counted) * 100 : null,
          atRiskCount: atRisk,
          strength: studentsInSection.length,
        });
      }
    }
    return rows.sort((a, b) =>
      a.sectionId === b.sectionId
        ? a.subjectCode.localeCompare(b.subjectCode)
        : a.sectionId.localeCompare(b.sectionId),
    );
  },
};

export { DEMO_PASSWORD };

/** Exposed for the "reset demo data" action on the login screen. */
export function resetMockData() {
  localStorage.removeItem(STORAGE_KEY);
  init();
}

/**
 * Sign-in shortcuts for reviewers.
 *
 * These are resolved from the live store rather than hardcoded, so the email
 * shown on the login screen can never drift from the account that exists.
 */
export interface DemoAccount {
  label: string;
  detail: string;
  email: string;
  password: string;
  role: Role;
}

export function demoAccounts(): DemoAccount[] {
  const accounts: DemoAccount[] = [];

  const hod = db.teachers.find((t) => t.isHod);
  if (hod) {
    accounts.push({
      label: "HOD",
      detail: `${hod.name} · ${hod.departmentName ?? "department"}`,
      email: hod.email,
      password: DEMO_PASSWORD,
      role: "teacher",
    });
  }

  const admin = db.teachers.find((t) => !t.isHod && t.departmentId);
  if (admin) {
    accounts.push({
      label: "Teacher",
      detail: `${admin.name} · ${admin.assignments.length} class(es)`,
      email: admin.email,
      password: DEMO_PASSWORD,
      role: "teacher",
    });
  }

  const student = db.students.find((s) => s.studentId === "4377") ?? db.students[0];
  if (student) {
    accounts.push({
      label: "Student",
      detail: `${student.name} · ${student.sectionId}`,
      email: student.email,
      password: DEMO_PASSWORD,
      role: "student",
    });
  }

  return accounts;
}

export const MOCK_BRANCHES = ["CSE", "IT", "ECE", "EEE", "MECH", "CIVIL"];
export const MOCK_YEARS = [1, 2, 3, 4];
export const MOCK_SECTIONS = ["A", "B", "C"];
export const ROLE_LABELS: Record<Role, string> = {
  student: "Student",
  teacher: "Teacher / Admin",
};

export const ATTENDANCE_STATUS_VALUES: AttendanceStatus[] = [
  "present",
  "absent",
  "late",
  "excused",
  "unmarked",
];

export function isoToday() {
  return toIsoDate(new Date());
}

export function isoDaysAgo(days: number) {
  return toIsoDate(addDays(new Date(), -days));
}
