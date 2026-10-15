/* ---------------------------------------------------------------------------
   Domain types.

   These mirror what the Python API will return, and they are deliberately
   shaped around the EXISTING database so nothing has to be re-modelled later:

     attendance.db → students(student_id, name, embedding)
                   → attendance(student_id, date, in_time, out_time)
                   → student_embeddings(...)

   `studentId` IS the column `students.student_id` — i.e. the roll number the
   student types at signup. Keeping that identical means register.py /
   liv_recog.py / ref_store.py keep working against the same rows with no
   translation layer.
--------------------------------------------------------------------------- */

export type Role = "student" | "teacher";

export type AttendanceStatus =
  | "present"
  | "absent"
  | "late"
  | "excused"
  | "unmarked";

export type AttendanceMethod = "face" | "manual";

export interface CameraDevice {
  source: string;
  name: string;
  cameraType: "usb" | "ip";
  sectionId?: string;
}

export interface RecognitionCameraRun {
  source: string;
  cameraId: string;
  name: string;
  cameraType: "usb" | "ip";
  sectionId: string;
  eventType: "entry" | "exit";
  eventCode: 0 | 1;
  running: boolean;
}

/** How a session was captured. Face = the liv_recog.py pipeline. */
export interface ClassSection {
  id: string; // "CSE-3-A"
  branch: string; // "CSE"
  year: number; // 3
  section: string; // "A"
  strength: number;
}

export interface Subject {
  id: string;
  code: string; // "CS301"
  name: string; // "Database Management Systems"
  branch: string;
  year: number;
}

/** One recurring class in the weekly timetable. */
export interface TimetableSlot {
  id: string;
  sectionId: string;
  subjectId: string;
  teacherId: string; // users.id of the teacher taking it
  dayOfWeek: number; // 1 = Monday … 6 = Saturday
  startTime: string; // "10:00"
  endTime: string; // "10:50"
  room: string;
  dateChange?: "modified" | "added";
}

export interface TimetableChangeInput {
  date: string;
  sectionId: string;
  kind: "cancel" | "modify" | "add";
  slotId?: string;
  subjectId?: string;
  startTime?: string;
  endTime?: string;
  room?: string;
}

export interface TimetableChangePreview {
  kind: TimetableChangeInput["kind"];
  date: string;
  slot: TimetableSlot;
}

export interface AttendanceRecord {
  id: string;
  studentId: string;
  subjectId: string;
  slotId: string;
  sectionId: string;
  date: string; // YYYY-MM-DD
  status: AttendanceStatus;
  inTime: string | null;
  outTime: string | null;
  method: AttendanceMethod;
  markedBy: string | null; // users.id when method === "manual"
}

export interface StudentProfile {
  studentId: string; // == students.student_id == roll number
  userId: string;
  name: string;
  email: string;
  collegeName?: string;
  branch: string;
  year: number;
  section: string;
  sectionId: string;
  /** True once an embedding exists in `students` (or harvested refs exist). */
  faceEnrolled: boolean;
  /** Extra reference embeddings harvested by liv_recog.py (max 4). */
  harvestedReferences: number;
  joinedAt: string;
  enrollmentStatus: "pending" | "approved" | "rejected";
}

export interface TeachingAssignment {
  id: string;
  subjectId: string;
  subjectCode: string;
  subjectName: string;
  sectionId: string;
  branch: string;
  year: number;
  section: string;
  periodsPerWeek: number;
}

export interface TeacherProfile {
  userId: string;
  name: string;
  email: string;
  collegeName?: string;
  departmentId: string | null;
  departmentName: string | null;
  isHod: boolean;
  assignments: TeachingAssignment[];
}

export type SessionUser =
  | { role: "student"; profile: StudentProfile }
  | { role: "teacher"; profile: TeacherProfile };

/* ---------------------------------------------------------------- department */

export interface DeptPermissions {
  manageTimetable: boolean;
  markAttendance: boolean;
  enrollStudents: boolean;
  postAnnouncements: boolean;
  viewAnalytics: boolean;
}

export interface Department {
  id: string;
  name: string;
  /** The join code the HOD generates and shares. Rotatable. */
  joinCode: string;
  hodUserId: string;
  hodName: string;
  createdAt: string;
  memberCount: number;
}

export interface DeptMember {
  userId: string;
  name: string;
  email: string;
  role: "hod" | "admin";
  joinedAt: string;
  permissions: DeptPermissions;
  assignedSections: string[];
}

export type DeptPostKind = "announcement" | "coverage_request" | "timetable_change";

export interface DeptPost {
  id: string;
  deptId: string;
  authorUserId: string;
  authorName: string;
  kind: DeptPostKind;
  title: string;
  body: string;
  createdAt: string;
  /** Only meaningful for coverage_request. */
  status: "open" | "resolved";
  claimedByUserId: string | null;
  claimedByName: string | null;
  relatedSlotId: string | null;
  relatedDate: string | null;
}

export interface DeptReply {
  id: string;
  postId: string;
  authorUserId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

/* ---------------------------------------------------------------- reporting */

export interface SubjectAttendanceSummary {
  subjectId: string;
  subjectCode: string;
  subjectName: string;
  heldCount: number;
  presentCount: number;
  absentCount: number;
  lateCount: number;
  excusedCount: number;
  /** (present + late) / completed, non-excused sessions, as a 0–100 number. */
  percentage: number | null;
}

/** One row of "today's schedule" for a student. */
export interface TodayEntry {
  slot: TimetableSlot;
  subject: Subject;
  teacherName: string;
  record: AttendanceRecord | null;
  status: AttendanceStatus;
}

export interface ClassAttendanceRow {
  studentId: string;
  name: string;
  faceEnrolled: boolean;
  status: AttendanceStatus;
  inTime: string | null;
  method: AttendanceMethod | null;
  enrollmentStatus: "pending" | "approved" | "rejected";
  reviewRequired?: boolean;
  reviewReason?: "early_exit" | "not_observed" | null;
}

export interface AttendanceSessionState {
  completed: boolean;
  completedAt: string | null;
  cameraSession?: boolean;
}
