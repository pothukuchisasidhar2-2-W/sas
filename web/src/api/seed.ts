/* ---------------------------------------------------------------------------
   Demo dataset for the mocked API layer.

   Everything here is generated DETERMINISTICALLY (seeded PRNG) so the numbers
   a reviewer sees — attendance percentages, rosters — are identical on every
   reload. A demo that reshuffles itself on refresh makes bugs impossible to
   reason about.

   Two students are taken straight from the real attendance.db so the mock and
   production agree: roll 4377 (Sasidhar) and roll 4349 (Charan), both with 0
   harvested reference embeddings.
--------------------------------------------------------------------------- */

import type {
  AttendanceRecord,
  AttendanceStatus,
  ClassSection,
  Department,
  DeptMember,
  DeptPermissions,
  DeptPost,
  Role,
  StudentProfile,
  Subject,
  TeacherProfile,
  TeachingAssignment,
  TimetableSlot,
} from "./types";

export interface MockUser {
  id: string;
  email: string;
  password: string;
  role: Role;
}

/**
 * A department membership as STORED.
 *
 * `departmentId` is deliberately absent from the public `DeptMember` type:
 * the API only ever returns members of your own department, so repeating the
 * id on the wire would carry no information.
 */
export interface MemberRecord extends DeptMember {
  departmentId: string;
}

export interface SeedDatabase {
  users: MockUser[];
  students: StudentProfile[];
  teachers: TeacherProfile[];
  sections: ClassSection[];
  subjects: Subject[];
  slots: TimetableSlot[];
  attendance: AttendanceRecord[];
  departments: Department[];
  members: MemberRecord[];
  posts: DeptPost[];
}

export const DEMO_PASSWORD = "demo1234";

/* --------------------------------------------------------------- utilities */

/** Small deterministic PRNG (mulberry32) — same input, same output, always. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable hash of a string, used to give each student a consistent aptitude. */
function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .trim()
    .replace(/\s+/g, ".");
}

function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const hh = String(Math.floor(total / 60) % 24).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/* --------------------------------------------------------------------- data */

const FIRST_NAMES = [
  "Aarav", "Aditi", "Akash", "Ananya", "Arjun", "Bhavya", "Deepika", "Dhruv",
  "Esha", "Gaurav", "Harini", "Ishaan", "Jahnavi", "Karthik", "Kavya", "Lakshmi",
  "Manish", "Naveen", "Nikitha", "Pranav", "Rahul", "Riya", "Sahithi", "Sanjay",
  "Shreya", "Sneha", "Surya", "Tanvi", "Tejas", "Varun", "Vikram", "Yamini",
];

const LAST_NAMES = [
  "Reddy", "Sharma", "Rao", "Kumar", "Patel", "Nair", "Iyer", "Gupta",
  "Singh", "Das", "Menon", "Verma", "Joshi", "Chowdary", "Pillai", "Naidu",
];

const SECTION_BLUEPRINT = [
  { id: "CSE-3-A", branch: "CSE", year: 3, section: "A", count: 24, offset: 0 },
  { id: "CSE-3-B", branch: "CSE", year: 3, section: "B", count: 22, offset: 400 },
];

/** Rolls already present in the real attendance.db, kept real on purpose. */
const REAL_STUDENTS: Record<string, { name: string; harvested: number }> = {
  "4377": { name: "Sasidhar", harvested: 0 },
  "4349": { name: "Charan", harvested: 0 },
};

const CSE_SUBJECTS: Subject[] = [
  { id: "CS301", code: "CS301", name: "Database Management Systems", branch: "CSE", year: 3 },
  { id: "CS302", code: "CS302", name: "Operating Systems", branch: "CSE", year: 3 },
  { id: "CS303", code: "CS303", name: "Computer Networks", branch: "CSE", year: 3 },
  { id: "CS304", code: "CS304", name: "Design & Analysis of Algorithms", branch: "CSE", year: 3 },
  { id: "CS305", code: "CS305", name: "Software Engineering", branch: "CSE", year: 3 },
];

/** Monday→Saturday grid. Slot index drives the period time. */
const PERIOD_TIMES: Array<[string, string]> = [
  ["09:00", "09:50"],
  ["10:00", "10:50"],
  ["11:10", "12:00"],
  ["13:00", "13:50"],
  ["14:00", "14:50"],
];

const DEFAULT_PERMISSIONS: DeptPermissions = {
  manageTimetable: true,
  markAttendance: true,
  enrollStudents: true,
  postAnnouncements: true,
  viewAnalytics: true,
};

const HOD_PERMISSIONS: DeptPermissions = {
  manageTimetable: true,
  markAttendance: true,
  enrollStudents: true,
  postAnnouncements: true,
  viewAnalytics: true,
};

const HISTORY_DAYS = 56;

export function createSeedDatabase(now = new Date()): SeedDatabase {
  const users: MockUser[] = [];
  const students: StudentProfile[] = [];
  const teachers: TeacherProfile[] = [];
  const sections: ClassSection[] = [];
  const slots: TimetableSlot[] = [];
  const attendance: AttendanceRecord[] = [];

  /* ------------------------------------------------------------ departments */

  const departments: Department[] = [
    {
      id: "dept-cse",
      name: "Computer Science & Engineering",
      joinCode: "CSE-7X4K-9QP2",
      hodUserId: "u-meera",
      hodName: "Dr. Meera Rao",
      createdAt: toIsoDate(addDays(now, -220)),
      memberCount: 3,
    },
    {
      id: "dept-ece",
      name: "Electronics & Communication",
      joinCode: "ECE-2M8T-5RD1",
      hodUserId: "u-ravi",
      hodName: "Dr. Ravi Teja",
      createdAt: toIsoDate(addDays(now, -180)),
      memberCount: 1,
    },
  ];

  const members: MemberRecord[] = [];

  /* --------------------------------------------------------------- teachers */

  const teacherSpecs = [
    {
      userId: "u-meera",
      name: "Dr. Meera Rao",
      deptId: "dept-cse",
      isHod: true,
      teaches: ["CS303"], // Computer Networks, both sections
      sections: ["CSE-3-A", "CSE-3-B"],
    },
    {
      userId: "u-anil",
      name: "Prof. Anil Kumar",
      deptId: "dept-cse",
      isHod: false,
      teaches: ["CS301", "CS302"], // DBMS + OS, section A only
      sections: ["CSE-3-A"],
    },
    {
      userId: "u-priya",
      name: "Prof. Priya Nair",
      deptId: "dept-cse",
      isHod: false,
      teaches: ["CS301", "CS302"], // DBMS + OS, section B only
      sections: ["CSE-3-B"],
    },
    {
      userId: "u-ravi",
      name: "Dr. Ravi Teja",
      deptId: "dept-ece",
      isHod: true,
      teaches: [],
      sections: [],
    },
  ];

  /* ---------------------------------------------------------------- sections */

  for (const spec of SECTION_BLUEPRINT) {
    sections.push({
      id: spec.id,
      branch: spec.branch,
      year: spec.year,
      section: spec.section,
      strength: spec.count,
    });
  }

  /* ---------------------------------------------------------------- students */

  for (const spec of SECTION_BLUEPRINT) {
    for (let i = 0; i < spec.count; i += 1) {
      const isFirstSection = spec.section === "A";
      // Seed order matches CSE-3-A's blueprint: 4377, 4349, then generated rolls.
      const realId =
        isFirstSection && i === 0 ? "4377" : isFirstSection && i === 1 ? "4349" : null;

      const generatedRollIndex = isFirstSection ? i - 2 : i;
      const studentId =
        realId ?? String(4350 + generatedRollIndex + spec.offset / 10).padStart(4, "0");

      const real = REAL_STUDENTS[studentId];
      const first = FIRST_NAMES[(i + spec.offset) % FIRST_NAMES.length];
      const last = LAST_NAMES[(i * 7 + spec.offset) % LAST_NAMES.length];
      const name = real ? real.name : `${first} ${last}`;

      const userId = `u-${studentId}`;
      const email = `${slug(name)}.${studentId}@college.edu`;
      const student: StudentProfile = {
        studentId,
        userId,
        name,
        email,
        branch: spec.branch,
        year: spec.year,
        section: spec.section,
        sectionId: spec.id,
        // Everyone is enrolled except two, so the "enrollment pending" path
        // is visible in the roster without hunting for the demo account.
        faceEnrolled: i !== 5 && i !== 12,
        harvestedReferences: real ? real.harvested : hashString(studentId) % 5,
        joinedAt: toIsoDate(addDays(now, -200 + (i % 40))),
        enrollmentStatus: "approved",
      };
      students.push(student);
      users.push({ id: userId, email, password: DEMO_PASSWORD, role: "student" });
    }
  }

  /* --------------------------------------------------------------- timetable */

  // Subject → teacher, per section. Meera (HOD) covers CN in both sections.
  const subjectTeacher: Record<string, Record<string, string>> = {
    "CSE-3-A": { CS301: "u-anil", CS302: "u-anil", CS303: "u-meera", CS304: "u-anil", CS305: "u-meera" },
    "CSE-3-B": { CS301: "u-priya", CS302: "u-priya", CS303: "u-meera", CS304: "u-priya", CS305: "u-priya" },
  };

  const sectionSubjects: Subject[] = CSE_SUBJECTS;

  for (const spec of SECTION_BLUEPRINT) {
    let counter = 0;
    for (let day = 1; day <= 6; day += 1) {
      // Five periods a day, subject rotating so every subject gets a slot.
      for (let period = 0; period < PERIOD_TIMES.length; period += 1) {
        const subject = sectionSubjects[(counter + period) % sectionSubjects.length];
        const teacherId = subjectTeacher[spec.id][subject.id];
        if (!teacherId) continue;
        const [startTime, endTime] = PERIOD_TIMES[period];
        slots.push({
          id: `slot-${spec.id}-${day}-${period}`,
          sectionId: spec.id,
          subjectId: subject.id,
          teacherId,
          dayOfWeek: day,
          startTime,
          endTime,
          room: `${spec.branch}-Block · ${200 + period}`,
        });
      }
      counter += 1;
    }
  }

  /* -------------------------------------------------------------- attendance */

  const start = addDays(now, -HISTORY_DAYS);
  const todayIso = toIsoDate(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (let dayOffset = 0; dayOffset <= HISTORY_DAYS; dayOffset += 1) {
    const date = addDays(start, dayOffset);
    const iso = toIsoDate(date);
    const dow = date.getDay(); // 0 = Sunday
    if (dow === 0) continue; // no classes on Sunday

    const daySlots = slots.filter((slot) => slot.dayOfWeek === dow);

    for (const slot of daySlots) {
      const [sh, sm] = slot.startTime.split(":").map(Number);
      const slotStartMinutes = sh * 60 + sm;

      // Today's not-yet-started periods have no rows at all — exactly like the
      // real pipeline, which only inserts when a face is actually recognized.
      if (iso === todayIso && slotStartMinutes > nowMinutes) continue;

      const section = sections.find((s) => s.id === slot.sectionId)!;
      const isToday = iso === todayIso;

      for (const student of students.filter((s) => s.sectionId === section.id)) {
        const rng = prng(hashString(`${student.studentId}|${slot.id}|${iso}`));
        // Per-student baseline aptitude, so one student is consistently ~95%
        // and another ~72% instead of everyone hovering at the average.
        const aptitude = 0.68 + (hashString(`apt|${student.studentId}`) % 30) / 100;

        // Partially-elapsed periods today are marked less reliably.
        const rolling = isToday ? 0.9 : 1;
        const roll = rng();

        let status: AttendanceStatus;
        if (roll < aptitude * rolling) {
          status = rng() < 0.08 ? "late" : "present";
        } else if (rng() < 0.12) {
          status = "excused";
        } else {
          status = "absent";
        }

        const present = status === "present" || status === "late";
        const record: AttendanceRecord = {
          id: `att-${iso}-${slot.id}-${student.studentId}`,
          studentId: student.studentId,
          subjectId: slot.subjectId,
          slotId: slot.id,
          sectionId: section.id,
          date: iso,
          status,
          inTime: present
            ? addMinutes(slot.startTime, status === "late" ? 7 + Math.floor(rng() * 8) : Math.floor(rng() * 4))
            : null,
          outTime: null,
          method: rng() < 0.82 ? "face" : "manual",
          markedBy: null,
        };
        if (record.method === "manual") record.markedBy = slot.teacherId;
        attendance.push(record);
      }
    }
  }

  /* ------------------------------------------------------------------- users */

  for (const spec of teacherSpecs) {
    users.push({
      id: spec.userId,
      email: `${slug(spec.name)}@college.edu`,
      password: DEMO_PASSWORD,
      role: "teacher",
    });

    const dept = departments.find((d) => d.id === spec.deptId)!;
    const assignments: TeachingAssignment[] = [];
    for (const sectionId of spec.sections) {
      for (const subjectId of spec.teaches) {
        const subject = CSE_SUBJECTS.find((s) => s.id === subjectId);
        if (!subject) continue;
        const section = sections.find((s) => s.id === sectionId)!;
        assignments.push({
          id: `asg-${spec.userId}-${sectionId}-${subjectId}`,
          subjectId,
          subjectCode: subject.code,
          subjectName: subject.name,
          sectionId,
          branch: section.branch,
          year: section.year,
          section: section.section,
          periodsPerWeek: slots.filter(
            (s) => s.sectionId === sectionId && s.subjectId === subjectId && s.teacherId === spec.userId,
          ).length,
        });
      }
    }

    const profile: TeacherProfile = {
      userId: spec.userId,
      name: spec.name,
      email: `${slug(spec.name)}@college.edu`,
      departmentId: dept.id,
      departmentName: dept.name,
      isHod: spec.isHod,
      assignments,
    };
    teachers.push(profile);

    members.push({
      userId: spec.userId,
      name: spec.name,
      email: profile.email,
      departmentId: spec.deptId,
      role: spec.isHod ? "hod" : "admin",
      joinedAt: spec.isHod ? dept.createdAt : toIsoDate(addDays(now, -60 - hashString(spec.userId) % 40)),
      permissions: spec.isHod ? { ...HOD_PERMISSIONS } : { ...DEFAULT_PERMISSIONS },
      assignedSections: [...spec.sections],
    });
  }

  /* -------------------------------------------------------------------- posts */

  const posts: DeptPost[] = [
    {
      id: "post-1",
      deptId: "dept-cse",
      authorUserId: "u-meera",
      authorName: "Dr. Meera Rao",
      kind: "announcement",
      title: "Mid-semester attendance audit on the 20th",
      body:
        "Please make sure every marked session for your sections is reconciled before the 20th. Anything below 75% gets flagged automatically by the analytics tab.",
      createdAt: addDays(now, -2).toISOString(),
      status: "open",
      claimedByUserId: null,
      claimedByName: null,
      relatedSlotId: null,
      relatedDate: null,
    },
    {
      id: "post-2",
      deptId: "dept-cse",
      authorUserId: "u-anil",
      authorName: "Prof. Anil Kumar",
      kind: "coverage_request",
      title: "Need cover — DBMS, CSE-3-A, Friday 10:00",
      body:
        "I'm at the AICTE review on Friday. If someone can take the 10:00 DBMS period for CSE-3-A, I'll reciprocate next week for any of your periods.",
      createdAt: addDays(now, -1).toISOString(),
      status: "open",
      claimedByUserId: null,
      claimedByName: null,
      relatedSlotId: "slot-CSE-3-A-5-1",
      relatedDate: null,
    },
    {
      id: "post-3",
      deptId: "dept-cse",
      authorUserId: "u-priya",
      authorName: "Prof. Priya Nair",
      kind: "timetable_change",
      title: "OS lab moved to Thursday 14:00",
      body:
        "The OS lab for CSE-3-B shifts to Thursday 14:00 from this week because the machines are being imaged on Wednesday.",
      createdAt: addDays(now, -4).toISOString(),
      status: "resolved",
      claimedByUserId: null,
      claimedByName: null,
      relatedSlotId: null,
      relatedDate: null,
    },
  ];

  return {
    users,
    students,
    teachers,
    sections,
    subjects: CSE_SUBJECTS,
    slots,
    attendance,
    departments,
    members,
    posts,
  };
}
