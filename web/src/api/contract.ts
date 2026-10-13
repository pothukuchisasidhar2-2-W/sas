/* ---------------------------------------------------------------------------
   The API contract.

   Every screen talks ONLY to this interface. Today it is fulfilled by the mock
   store (src/api/mock.ts); when the FastAPI backend exists, src/api/client.ts
   fulfils the same interface with real HTTP calls and NOTHING in the UI
   changes. That is the whole point of writing the contract down first.

   Each method maps to the endpoint named in its doc comment.
--------------------------------------------------------------------------- */

import type {
  AttendanceRecord,
  AttendanceStatus,
  ClassAttendanceRow,
  Department,
  DeptMember,
  DeptPermissions,
  DeptPost,
  DeptPostKind,
  DeptReply,
  SessionUser,
  SubjectAttendanceSummary,
  TimetableSlot,
  TodayEntry,
} from "./types";

export interface ApiError {
  status: number;
  message: string;
}

export class HttpError extends Error implements ApiError {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export interface SignupStudentInput {
  name: string;
  email: string;
  emailCode: string;
  password: string;
  branch: string;
  year: number;
  section: string;
  /** Becomes the primary key in the existing `students` table. */
  studentId: string;
}

export interface SignupTeacherInput {
  name: string;
  email: string;
  emailCode: string;
  password: string;
  departmentName: string;
  assignments: Array<{
    subjectCode: string;
    subjectName: string;
    branch: string;
    year: number;
    section: string;
  }>;
  /** One-time teacher invitation; class permissions are read from this code. */
  inviteCode: string;
}

export interface Session {
  token: string;
  user: SessionUser;
}

export interface SectionOption {
  id: string;
  branch: string;
  year: number;
  section: string;
  strength: number;
}

export interface TimetableUploadResult {
  imported: number;
  replaced: number;
  errors: string[];
}

export interface DeptAnalytics {
  sectionId: string;
  subjectCode: string;
  subjectName: string;
  sessionsHeld: number;
  presentRate: number | null;
  atRiskCount: number | null;
  strength: number;
}

export interface Api {
  /* ------------------------------------------------------------------ auth */
  /** POST /api/auth/login */
  login(email: string, password: string): Promise<Session>;
  /** POST /api/auth/signup/student */
  signupStudent(input: SignupStudentInput): Promise<Session>;
  /** POST /api/auth/signup/teacher */
  signupTeacher(input: SignupTeacherInput): Promise<Session>;
  /** GET /api/auth/me */
  me(token: string): Promise<SessionUser>;
  /** POST /api/auth/logout */
  logout(token: string): Promise<void>;

  /* -------------------------------------------------------------- directory */
  /** GET /api/directory/sections */
  listSections(): Promise<SectionOption[]>;
  /** GET /api/directory/departments */
  listDepartments(): Promise<Department[]>;

  /* ----------------------------------------------------------------- student */
  /** GET /api/student/summary — per-subject percentage for the signed-in student */
  studentSummary(token: string): Promise<SubjectAttendanceSummary[]>;
  /** GET /api/student/schedule?date= */
  studentSchedule(token: string, date: string): Promise<TodayEntry[]>;
  /** GET /api/student/attendance?from=&to= */
  studentAttendance(token: string, from: string, to: string): Promise<AttendanceRecord[]>;
  /**
   * POST /api/student/enrollment
   * A webcam frame as a data URL. The backend runs the SAME YuNet + SFace
   * models as register.py and writes one unit-normalized embedding, so
   * liv_recog.py keeps matching it with no changes.
   */
  enrollFace(token: string, imageDataUrl: string): Promise<{ harvestedReferences: number }>;

  /* ----------------------------------------------------------------- teacher */
  /** GET /api/teacher/assignments — sections this teacher may see */
  teacherSections(token: string): Promise<SectionOption[]>;
  /** GET /api/teacher/roster?sectionId=&date=&slotId= */
  teacherRoster(
    token: string,
    params: { sectionId: string; date: string; slotId?: string },
  ): Promise<ClassAttendanceRow[]>;
  /** PATCH /api/teacher/students/:studentId/enrollment */
  reviewStudent(token: string, studentId: string, sectionId: string, status: "approved" | "rejected"): Promise<void>;
  /** PATCH /api/teacher/attendance */
  markAttendance(
    token: string,
    input: {
      studentId: string;
      slotId: string;
      date: string;
      status: AttendanceStatus;
      sectionId: string;
    },
  ): Promise<AttendanceRecord>;
  /** GET /api/teacher/schedule?date= */
  teacherSchedule(token: string, date: string): Promise<TimetableSlot[]>;
  /**
   * GET /api/timetable?sectionId=
   * Readable by a student of that section, or a teacher in scope for it.
   */
  sectionTimetable(token: string, sectionId: string): Promise<TimetableSlot[]>;
  /**
   * POST /api/teacher/timetable/upload
   * CSV columns: day,start,end,subject_code,subject_name,section,room,teacher_email
   */
  uploadTimetable(
    token: string,
    input: { sectionId: string; csv: string },
  ): Promise<TimetableUploadResult>;
  previewTimetable(
    token: string,
    input: { sectionId: string; csv: string },
  ): Promise<TimetableUploadResult>;

  /* -------------------------------------------------------------- department */
  /** GET /api/departments/mine */
  myDepartment(token: string): Promise<Department | null>;
  /** POST /api/departments — creating one makes you its HOD */
  createDepartment(token: string, name: string): Promise<Department>;
  /** POST /api/departments/join */
  joinDepartment(token: string, code: string): Promise<Department>;
  /** POST /api/departments/code/rotate */
  rotateDeptCode(token: string): Promise<Department>;
  /** GET /api/departments/members */
  deptMembers(token: string): Promise<DeptMember[]>;
  /** PATCH /api/departments/members/:userId/permissions (HOD only) */
  setMemberPermissions(
    token: string,
    userId: string,
    permissions: DeptPermissions,
  ): Promise<DeptMember>;
  /** GET /api/departments/posts */
  deptPosts(token: string): Promise<DeptPost[]>;
  deptReplies(token: string, postId: string): Promise<DeptReply[]>;
  createDeptReply(token: string, postId: string, body: string): Promise<DeptReply>;
  /** POST /api/departments/posts */
  createDeptPost(
    token: string,
    input: {
      kind: DeptPostKind;
      title: string;
      body: string;
      relatedSlotId?: string | null;
      relatedDate?: string | null;
    },
  ): Promise<DeptPost>;
  /** POST /api/departments/posts/:id/claim */
  claimDeptPost(token: string, postId: string): Promise<DeptPost>;
  /** POST /api/departments/posts/:id/resolve */
  resolveDeptPost(token: string, postId: string): Promise<DeptPost>;
  /** GET /api/departments/analytics */
  deptAnalytics(token: string): Promise<DeptAnalytics[]>;
}
