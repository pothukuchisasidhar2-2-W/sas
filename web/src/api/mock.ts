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
  AttendanceStatus,
  ClassAttendanceRow,
  Department,
  DeptMember,
  DeptPermissions,
  DeptPost,
  DeptPostKind,
  Role,
  SessionUser,
  StudentProfile,
  Subject,
  SubjectAttendanceSummary,
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
  attendanceOverrides: AttendanceRecord[];
}

/** The live in-memory database: generated history + persisted mutations. */
let db: SeedDatabase;
let attendanceOverrides: AttendanceRecord[] = [];

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
    attendanceOverrides,
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
    attendanceOverrides = saved.attendanceOverrides ?? [];
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
    if (db.students.some((s) => s.studentId === input.studentId)) {
      fail(409, `Roll number ${input.studentId} is already registered.`);
    }

    const userId = `u-${input.studentId}`;
    const section = ensureSection(input.branch, input.year, input.section);
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
      departmentName: input.departmentName || null,
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

    const dow = new Date(`${date}T00:00:00`).getDay();
    const daySlots = db.slots
      .filter((s) => s.sectionId === user.profile.sectionId && s.dayOfWeek === dow)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

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
        (r) => r.studentId === user.profile.studentId && r.date >= from && r.date <= to,
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

    const roster = db.students.filter((s) => s.sectionId === params.sectionId);
    const daySlots = db.slots
      .filter((s) => s.sectionId === params.sectionId)
      .filter((s) => s.dayOfWeek === new Date(`${params.date}T00:00:00`).getDay());

    const relevant = params.slotId
      ? daySlots.filter((s) => s.id === params.slotId)
      : daySlots;
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
            status: "unmarked",
            inTime: null,
            method: null,
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
          status: best.status,
          inTime: best.inTime,
          method: best.method,
        };
      })
      .sort((a, b) => a.studentId.localeCompare(b.studentId));
  },

  async markAttendance(token, input) {
    await net();
    assertSectionInScope(token, input.sectionId);
    const user = currentUser(token);
    const userId = user.role === "teacher" ? user.profile.userId : null;

    const id = `att-${input.date}-${input.slotId}-${input.studentId}`;
    const record: AttendanceRecord = {
      id,
      studentId: input.studentId,
      subjectId: db.slots.find((s) => s.id === input.slotId)?.subjectId ?? "UNKNOWN",
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

  async teacherSchedule(token, date) {
    await net();
    const user = currentUser(token);
    if (user.role !== "teacher") fail(403, "Teachers only.");
    const dow = new Date(`${date}T00:00:00`).getDay();

    if (user.profile.isHod && user.profile.departmentId) {
      const deptSections = new Set(
        sectionOptionsForTeacher(user.profile).map((s) => s.id),
      );
      return db.slots
        .filter((s) => s.dayOfWeek === dow && deptSections.has(s.sectionId))
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
    }

    return db.slots
      .filter((s) => s.dayOfWeek === dow && s.teacherId === user.profile.userId)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  },

  async sectionTimetable(token, sectionId) {
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
    return db.slots
      .filter((s) => s.sectionId === sectionId)
      .sort((a, b) =>
        a.dayOfWeek === b.dayOfWeek
          ? a.startTime.localeCompare(b.startTime)
          : a.dayOfWeek - b.dayOfWeek,
      );
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
          (r) => r.sectionId === section.id && r.subjectId === subjectId,
        );
        const sessionKeys = new Set(records.map((r) => r.date));
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
