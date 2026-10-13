"""True Eye API backed by the existing attendance SQLite database.

The legacy students/attendance tables are never rebuilt. Application tables
are additive so the local recognition scripts continue to use the same data.
"""
from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import io
import json
import os
import secrets
import sqlite3
import uuid
from contextlib import asynccontextmanager, contextmanager
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

import cv2
import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.environ.get("TRUE_EYE_DB", ROOT / "attendance.db")).resolve()
MODEL_DETECT = ROOT / "models" / "face_detection_yunet_2026may.onnx"
MODEL_RECOGNIZE = ROOT / "models" / "face_recognition_sface_2021dec.onnx"
SESSION_HOURS = 8
ATTENDANCE_THRESHOLD = float(os.environ.get("TRUE_EYE_ATTENDANCE_THRESHOLD", "75"))


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA busy_timeout = 10000")
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS true_eye_schema (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('student','teacher')),
  name TEXT NOT NULL, created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS api_sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_sessions_user ON api_sessions(user_id);
CREATE TABLE IF NOT EXISTS activation_invites (
  code_hash TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('student','teacher')),
  payload TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY, branch TEXT NOT NULL, year INTEGER NOT NULL,
  section TEXT NOT NULL, UNIQUE(branch,year,section)
);
CREATE TABLE IF NOT EXISTS student_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL UNIQUE REFERENCES students(student_id),
  section_id TEXT NOT NULL REFERENCES sections(id), joined_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teacher_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  department_id TEXT
);
CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  branch TEXT NOT NULL, year INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS teaching_assignments (
  id TEXT PRIMARY KEY, teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL REFERENCES subjects(id), section_id TEXT NOT NULL REFERENCES sections(id),
  periods_per_week INTEGER NOT NULL DEFAULT 1,
  UNIQUE(teacher_id,subject_id,section_id)
);
CREATE INDEX IF NOT EXISTS idx_assignments_section ON teaching_assignments(section_id);
CREATE TABLE IF NOT EXISTS timetable_slots (
  id TEXT PRIMARY KEY, section_id TEXT NOT NULL REFERENCES sections(id),
  subject_id TEXT NOT NULL REFERENCES subjects(id), teacher_id TEXT NOT NULL REFERENCES users(id),
  day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 1 AND 6),
  start_time TEXT NOT NULL, end_time TEXT NOT NULL, room TEXT NOT NULL DEFAULT '',
  UNIQUE(section_id,day_of_week,start_time),
  CHECK(start_time < end_time)
);
CREATE INDEX IF NOT EXISTS idx_slots_teacher_day ON timetable_slots(teacher_id,day_of_week);
CREATE TABLE IF NOT EXISTS class_attendance (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(student_id),
  slot_id TEXT NOT NULL REFERENCES timetable_slots(id), date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('present','absent','late','excused')),
  in_time TEXT, out_time TEXT, method TEXT NOT NULL CHECK(method IN ('face','manual')),
  marked_by TEXT REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE(student_id,slot_id,date)
);
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  join_code_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, hod_user_id TEXT NOT NULL REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS department_members (
  department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
  manage_timetable INTEGER NOT NULL DEFAULT 0, mark_attendance INTEGER NOT NULL DEFAULT 0,
  enroll_students INTEGER NOT NULL DEFAULT 0, post_announcements INTEGER NOT NULL DEFAULT 0,
  view_analytics INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(department_id,user_id)
);
CREATE TABLE IF NOT EXISTS department_posts (
  id TEXT PRIMARY KEY, department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', claimed_by TEXT REFERENCES users(id),
  related_slot_id TEXT REFERENCES timetable_slots(id), related_date TEXT
);
CREATE INDEX IF NOT EXISTS idx_dept_posts_time ON department_posts(department_id,created_at);
CREATE TABLE IF NOT EXISTS department_replies (
  id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES department_posts(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dept_replies_post ON department_replies(post_id,created_at);
"""


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Keep the existing schema bootstrap as the source of truth for the three
    # recognition tables; the web schema only adds its own tables afterwards.
    from db.database import create_database
    create_database(str(DB_PATH))
    with connect() as db:
        db.executescript(SCHEMA)
        row = db.execute("SELECT version FROM true_eye_schema LIMIT 1").fetchone()
        if row is None:
            db.execute("INSERT INTO true_eye_schema(version) VALUES (1)")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def uid() -> str:
    return str(uuid.uuid4())


def hash_secret(value: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", value.encode(), salt, 310_000)
    return f"pbkdf2_sha256${salt.hex()}${digest.hex()}"


def verify_secret(value: str, encoded: str) -> bool:
    try:
        scheme, salt_hex, digest_hex = encoded.split("$", 2)
        if scheme != "pbkdf2_sha256":
            return False
        return hmac.compare_digest(hash_secret(value, bytes.fromhex(salt_hex)).split("$", 2)[2], digest_hex)
    except (ValueError, TypeError):
        return False


def digest_token(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class LoginInput(BaseModel):
    email: str = Field(min_length=3, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    password: str = Field(min_length=8, max_length=256)


class StudentSignup(LoginInput):
    name: str = Field(min_length=1, max_length=120)
    branch: str = Field(min_length=1, max_length=32)
    year: int = Field(ge=1, le=8)
    section: str = Field(min_length=1, max_length=16)
    studentId: str = Field(min_length=1, max_length=64)
    inviteCode: str = Field(min_length=16, max_length=128)


class TeacherSignup(LoginInput):
    name: str = Field(min_length=1, max_length=120)
    departmentName: str = Field(default="", max_length=100)
    inviteCode: str = Field(min_length=16, max_length=128)
    assignments: list[dict[str, Any]] = Field(default_factory=list)


class DepartmentInput(BaseModel):
    name: str = Field(min_length=2, max_length=100)


class JoinInput(BaseModel):
    code: str = Field(min_length=16, max_length=128)


class PermissionInput(BaseModel):
    permissions: dict[str, bool]


class PostInput(BaseModel):
    kind: str = Field(pattern="^(announcement|coverage_request|timetable_change)$")
    title: str = Field(min_length=2, max_length=180)
    body: str = Field(min_length=1, max_length=8000)
    relatedSlotId: str | None = None
    relatedDate: str | None = None


class ReplyInput(BaseModel):
    body: str = Field(min_length=1, max_length=4000)


class MarkInput(BaseModel):
    studentId: str
    slotId: str
    date: str
    status: str = Field(pattern="^(present|absent|late|excused)$")
    sectionId: str


class TimetableInput(BaseModel):
    sectionId: str
    csv: str = Field(min_length=1, max_length=1_000_000)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="True Eye API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("TRUE_EYE_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(","),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


def get_user(authorization: str | None = Header(default=None)) -> sqlite3.Row:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Sign in to continue.")
    token = authorization[7:].strip()
    with connect() as db:
        row = db.execute("""SELECT u.* FROM api_sessions s JOIN users u ON u.id=s.user_id
          WHERE s.token_hash=? AND s.expires_at>? AND u.active=1""", (digest_token(token), now_iso())).fetchone()
    if row is None:
        raise HTTPException(401, "Your session has expired. Sign in again.")
    return row


def require_teacher(user: sqlite3.Row = Depends(get_user)) -> sqlite3.Row:
    if user["role"] != "teacher":
        raise HTTPException(403, "Teacher access is required.")
    return user


def student_profile(db: sqlite3.Connection, user: sqlite3.Row) -> dict[str, Any]:
    row = db.execute("""SELECT sp.*,s.branch,s.year,s.section,s.id section_id,u.name,u.email
      FROM student_profiles sp JOIN sections s ON s.id=sp.section_id
      JOIN users u ON u.id=sp.user_id WHERE sp.user_id=?""", (user["id"],)).fetchone()
    if row is None:
        raise HTTPException(404, "Student profile is not available.")
    embeddings = db.execute("SELECT COUNT(*) FROM student_embeddings WHERE student_id=?", (row["student_id"],)).fetchone()[0]
    enrolled = db.execute("SELECT 1 FROM students WHERE student_id=? AND length(embedding)>0", (row["student_id"],)).fetchone() is not None
    return {"studentId": row["student_id"], "userId": row["user_id"], "name": row["name"], "email": row["email"],
            "branch": row["branch"], "year": row["year"], "section": row["section"], "sectionId": row["section_id"],
            "faceEnrolled": enrolled, "harvestedReferences": embeddings, "joinedAt": row["joined_at"]}


def teacher_profile(db: sqlite3.Connection, user: sqlite3.Row) -> dict[str, Any]:
    profile = db.execute("""SELECT tp.department_id,d.name department_name FROM teacher_profiles tp
      LEFT JOIN departments d ON d.id=tp.department_id WHERE tp.user_id=?""", (user["id"],)).fetchone()
    rows = db.execute("""SELECT a.id assignment_id, su.id subject_id,su.code,su.name subject_name,
      su.branch,su.year,se.id section_id,se.section,a.periods_per_week
      FROM teaching_assignments a JOIN subjects su ON su.id=a.subject_id
      JOIN sections se ON se.id=a.section_id WHERE a.teacher_id=? ORDER BY se.id,su.code""", (user["id"],)).fetchall()
    is_hod = db.execute("SELECT 1 FROM departments WHERE hod_user_id=?", (user["id"],)).fetchone() is not None
    assignments = [{"id": r["assignment_id"], "subjectId": r["subject_id"], "subjectCode": r["code"],
      "subjectName": r["subject_name"], "sectionId": r["section_id"], "branch": r["branch"], "year": r["year"],
      "section": r["section"], "periodsPerWeek": r["periods_per_week"]} for r in rows]
    return {"userId": user["id"], "name": user["name"], "email": user["email"],
      "departmentId": profile["department_id"] if profile else None,
      "departmentName": profile["department_name"] if profile else None, "isHod": is_hod, "assignments": assignments}


def session_user(db: sqlite3.Connection, user: sqlite3.Row) -> dict[str, Any]:
    if user["role"] == "student":
        return {"role": "student", "profile": student_profile(db, user)}
    return {"role": "teacher", "profile": teacher_profile(db, user)}


def make_session(db: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    token = secrets.token_urlsafe(36)
    db.execute("INSERT INTO api_sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)",
      (digest_token(token), user_id, (datetime.now(timezone.utc)+timedelta(hours=SESSION_HOURS)).replace(microsecond=0).isoformat(), now_iso()))
    row = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return {"token": token, "user": session_user(db, row)}


def consume_invite(db: sqlite3.Connection, code: str, role: str) -> dict[str, Any]:
    row = db.execute("SELECT * FROM activation_invites WHERE code_hash=? AND role=? AND used_at IS NULL AND expires_at>?",
                     (digest_token(code), role, now_iso())).fetchone()
    if row is None:
        raise HTTPException(403, "That activation code is invalid, expired, or already used. Request a new code from your institution.")
    return json.loads(row["payload"])


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "product": "True Eye"}


@app.post("/api/auth/login")
def login(body: LoginInput) -> dict[str, Any]:
    with connect() as db:
        user = db.execute("SELECT * FROM users WHERE email=? COLLATE NOCASE AND active=1", (body.email,)).fetchone()
        if user is None or not verify_secret(body.password, user["password_hash"]):
            raise HTTPException(401, "Email or password is incorrect.")
        return make_session(db, user["id"])


def signup_common(body: StudentSignup | TeacherSignup, role: str) -> dict[str, Any]:
    with connect() as db:
        payload = consume_invite(db, body.inviteCode, role)
        if db.execute("SELECT 1 FROM users WHERE email=? COLLATE NOCASE", (body.email,)).fetchone():
            raise HTTPException(409, "An account already uses that email address.")
        user_id = uid()
        db.execute("INSERT INTO users(id,email,password_hash,role,name,created_at) VALUES (?,?,?,?,?,?)",
                   (user_id, body.email.lower(), hash_secret(body.password), role, body.name.strip(), now_iso()))
        if role == "student":
            assert isinstance(body, StudentSignup)
            sid = str(payload.get("studentId", ""))
            identity = db.execute("SELECT name FROM students WHERE student_id=?", (sid,)).fetchone()
            if not sid or body.studentId.strip() != sid or identity is None:
                raise HTTPException(403, "This code is not linked to that registered attendance identity.")
            branch = str(payload["branch"]).strip().upper()
            year = int(payload["year"])
            section = str(payload["section"]).strip().upper()
            section_id = f"{branch}-{year}-{section}"
            db.execute("INSERT OR IGNORE INTO sections(id,branch,year,section) VALUES (?,?,?,?)", (section_id, branch, year, section))
            db.execute("INSERT INTO student_profiles(user_id,student_id,section_id,joined_at) VALUES (?,?,?,?)",
                       (user_id, sid, section_id, now_iso()))
        else:
            db.execute("INSERT INTO teacher_profiles(user_id) VALUES (?)", (user_id,))
            dept_name = str(payload.get("departmentName", "")).strip()
            if dept_name:
                dept_id = uid()
                join_code = secrets.token_urlsafe(24)
                db.execute("INSERT INTO departments(id,name,join_code_hash,created_at,hod_user_id) VALUES (?,?,?,?,?)",
                           (dept_id, dept_name, digest_token(join_code), now_iso(), user_id))
                db.execute("INSERT INTO teacher_profiles(user_id,department_id) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET department_id=excluded.department_id", (user_id, dept_id))
                db.execute("INSERT INTO department_members(department_id,user_id,joined_at,role,manage_timetable,mark_attendance,enroll_students,post_announcements,view_analytics) VALUES (?,?,?,'hod',1,1,1,1,1)", (dept_id, user_id, now_iso()))
            for item in payload.get("assignments", []):
                branch = str(item["branch"]).strip().upper()
                year = int(item["year"])
                section = str(item["section"]).strip().upper()
                code = str(item["subjectCode"]).strip().upper()
                name = str(item["subjectName"]).strip()
                section_id = f"{branch}-{year}-{section}"
                subject_id = code
                db.execute("INSERT OR IGNORE INTO sections(id,branch,year,section) VALUES (?,?,?,?)", (section_id, branch, year, section))
                db.execute("INSERT INTO subjects(id,code,name,branch,year) VALUES (?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,branch=excluded.branch,year=excluded.year", (subject_id, code, name, branch, year))
                db.execute("INSERT OR IGNORE INTO teaching_assignments(id,teacher_id,subject_id,section_id) VALUES (?,?,?,?)", (uid(), user_id, subject_id, section_id))
        db.execute("UPDATE activation_invites SET used_at=? WHERE code_hash=?", (now_iso(), digest_token(body.inviteCode)))
        return make_session(db, user_id)


@app.post("/api/auth/signup/student")
def signup_student(body: StudentSignup) -> dict[str, Any]:
    return signup_common(body, "student")


@app.post("/api/auth/signup/teacher")
def signup_teacher(body: TeacherSignup) -> dict[str, Any]:
    return signup_common(body, "teacher")


@app.get("/api/auth/me")
def me(user: sqlite3.Row = Depends(get_user)) -> dict[str, Any]:
    with connect() as db:
        return session_user(db, db.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone())


@app.post("/api/auth/logout", status_code=204)
def logout(user: sqlite3.Row = Depends(get_user), authorization: str | None = Header(default=None)) -> None:
    token = authorization[7:].strip() if authorization else ""
    with connect() as db:
        db.execute("DELETE FROM api_sessions WHERE token_hash=?", (digest_token(token),))


def section_obj(row: sqlite3.Row) -> dict[str, Any]:
    return {"id": row["id"], "branch": row["branch"], "year": row["year"], "section": row["section"], "strength": row["strength"]}


def sections_for_teacher(db: sqlite3.Connection, teacher_id: str) -> list[dict[str, Any]]:
    rows = db.execute("""SELECT s.*, (SELECT COUNT(*) FROM student_profiles p WHERE p.section_id=s.id) strength
      FROM sections s JOIN teaching_assignments a ON a.section_id=s.id WHERE a.teacher_id=?
      UNION SELECT s.*, (SELECT COUNT(*) FROM student_profiles p WHERE p.section_id=s.id) strength
      FROM sections s JOIN department_members dm ON dm.user_id=? JOIN departments d ON d.id=dm.department_id
      JOIN teacher_profiles tp ON tp.user_id=? AND tp.department_id=d.id
      JOIN teaching_assignments a ON a.section_id=s.id
      JOIN teacher_profiles assigned ON assigned.user_id=a.teacher_id AND assigned.department_id=d.id""", (teacher_id, teacher_id, teacher_id)).fetchall()
    return [section_obj(r) for r in rows]


@app.get("/api/directory/sections")
def directory_sections(user: sqlite3.Row = Depends(get_user)) -> list[dict[str, Any]]:
    with connect() as db:
        if user["role"] == "student":
            rows = db.execute("SELECT s.*, (SELECT COUNT(*) FROM student_profiles p WHERE p.section_id=s.id) strength FROM sections s JOIN student_profiles p ON p.section_id=s.id WHERE p.user_id=?", (user["id"],)).fetchall()
        else:
            rows = sections_for_teacher(db, user["id"])
            return rows
        return [section_obj(r) for r in rows]


def department_obj(db: sqlite3.Connection, row: sqlite3.Row, include_code: bool = True) -> dict[str, Any]:
    count = db.execute("SELECT COUNT(*) FROM department_members WHERE department_id=?", (row["id"],)).fetchone()[0]
    hod = db.execute("SELECT name FROM users WHERE id=?", (row["hod_user_id"],)).fetchone()
    join_code = row["join_code"] if "join_code" in row.keys() else ""
    return {"id": row["id"], "name": row["name"], "joinCode": join_code if include_code else "",
      "hodUserId": row["hod_user_id"], "hodName": hod["name"] if hod else "", "createdAt": row["created_at"], "memberCount": count}


@app.get("/api/directory/departments")
def directory_departments(user: sqlite3.Row = Depends(get_user)) -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("""SELECT DISTINCT d.* FROM departments d JOIN department_members m ON m.department_id=d.id WHERE m.user_id=?""", (user["id"],)).fetchall()
        return [department_obj(db, row, include_code=False) for row in rows]


def require_assignment(db: sqlite3.Connection, teacher_id: str, section_id: str, slot_id: str | None = None) -> None:
    query = "SELECT 1 FROM teaching_assignments WHERE teacher_id=? AND section_id=?"
    params: tuple[Any, ...] = (teacher_id, section_id)
    if slot_id:
        query += " AND subject_id=(SELECT subject_id FROM timetable_slots WHERE id=? AND section_id=?)"
        params += (slot_id, section_id)
    if db.execute(query, params).fetchone() is None:
        # HODs may monitor department classes, but cannot mark without an assignment.
        hod = db.execute("""SELECT 1 FROM departments d
            JOIN teacher_profiles tp ON tp.department_id=d.id AND tp.user_id=?
            JOIN teaching_assignments a ON a.section_id=?
            JOIN teacher_profiles assigned ON assigned.user_id=a.teacher_id AND assigned.department_id=d.id
            WHERE d.hod_user_id=?""", (teacher_id, section_id, teacher_id)).fetchone()
        if hod is None or slot_id:
            raise HTTPException(403, "You are not assigned to this class.")


def slot_obj(row: sqlite3.Row) -> dict[str, Any]:
    return {"id": row["id"], "sectionId": row["section_id"], "subjectId": row["subject_id"], "teacherId": row["teacher_id"],
      "dayOfWeek": row["day_of_week"], "startTime": row["start_time"], "endTime": row["end_time"], "room": row["room"]}


def record_obj(row: sqlite3.Row, section_id: str, subject_id: str = "", slot_id: str = "") -> dict[str, Any]:
    return {"id": row["id"], "studentId": row["student_id"], "subjectId": subject_id, "slotId": slot_id,
      "sectionId": section_id, "date": row["date"], "status": row["status"], "inTime": row["in_time"],
      "outTime": row["out_time"], "method": row["method"], "markedBy": row["marked_by"]}


@app.get("/api/student/attendance")
def student_attendance(from_: str = __import__("fastapi").Query(default="", alias="from"), to: str = "", user: sqlite3.Row = Depends(get_user)) -> list[dict[str, Any]]:
    if user["role"] != "student":
        raise HTTPException(403, "Student access is required.")
    with connect() as db:
        p = student_profile(db, user)
        # Existing recognition rows have no subject/session assignment. Keep that explicit.
        q = "SELECT id,student_id,date,in_time,out_time FROM attendance WHERE student_id=?"
        args: list[Any] = [p["studentId"]]
        if from_:
            q += " AND date>=?"; args.append(from_)
        if to:
            q += " AND date<=?"; args.append(to)
        q += " ORDER BY date DESC,in_time DESC"
        legacy = db.execute(q, args).fetchall()
        result = [record_obj({"id": str(r["id"]), "student_id": r["student_id"], "date": r["date"], "in_time": r["in_time"], "out_time": r["out_time"], "status": "present", "method": "face", "marked_by": None}, p["sectionId"], "", "") for r in legacy]
        # Explicit period records carry a reliable timetable association.
        q2 = "SELECT ca.*,ts.subject_id,ts.id slot_id FROM class_attendance ca JOIN timetable_slots ts ON ts.id=ca.slot_id WHERE ca.student_id=?"
        a2: list[Any] = [p["studentId"]]
        if from_: q2 += " AND ca.date>=?"; a2.append(from_)
        if to: q2 += " AND ca.date<=?"; a2.append(to)
        result += [record_obj(r, p["sectionId"], r["subject_id"], r["slot_id"]) for r in db.execute(q2+" ORDER BY ca.date DESC,ca.in_time DESC", a2).fetchall()]
        return result


@app.get("/api/student/summary")
def student_summary(user: sqlite3.Row = Depends(get_user)) -> list[dict[str, Any]]:
    if user["role"] != "student":
        raise HTTPException(403, "Student access is required.")
    with connect() as db:
        p = student_profile(db, user)
        rows = db.execute("""SELECT s.id subject_id,s.code subject_code,s.name subject_name,
          COUNT(*) held_count,SUM(ca.status='present') present_count,SUM(ca.status='absent') absent_count,
          SUM(ca.status='late') late_count,SUM(ca.status='excused') excused_count
          FROM class_attendance ca JOIN timetable_slots ts ON ts.id=ca.slot_id JOIN subjects s ON s.id=ts.subject_id
          WHERE ca.student_id=? GROUP BY s.id""", (p["studentId"],)).fetchall()
        return [{"subjectId": r["subject_id"], "subjectCode": r["subject_code"], "subjectName": r["subject_name"],
          "heldCount": r["held_count"], "presentCount": r["present_count"], "absentCount": r["absent_count"],
          "lateCount": r["late_count"], "excusedCount": r["excused_count"],
          "percentage": round((r["present_count"]+r["late_count"])*100/(r["held_count"]-r["excused_count"]),1) if r["held_count"]>r["excused_count"] else None} for r in rows]


@app.get("/api/student/schedule")
def student_schedule(date_: str = __import__("fastapi").Query(default="", alias="date"), user: sqlite3.Row = Depends(get_user)) -> list[dict[str, Any]]:
    if user["role"] != "student": raise HTTPException(403, "Student access is required.")
    try: target = date.fromisoformat(date_) if date_ else date.today()
    except ValueError as exc: raise HTTPException(422, "Date must use YYYY-MM-DD.") from exc
    with connect() as db:
        p = student_profile(db, user)
        slots = db.execute("""SELECT ts.*,su.code,su.name subject_name,su.branch,su.year,u.name teacher_name
          FROM timetable_slots ts JOIN subjects su ON su.id=ts.subject_id JOIN users u ON u.id=ts.teacher_id
          WHERE ts.section_id=? AND ts.day_of_week=? ORDER BY ts.start_time""", (p["sectionId"], target.isoweekday())).fetchall()
        result = []
        for slot in slots:
            row = db.execute("SELECT * FROM class_attendance WHERE student_id=? AND slot_id=? AND date=?", (p["studentId"],slot["id"],target.isoformat())).fetchone()
            rec = record_obj(row, p["sectionId"], slot["subject_id"], slot["id"]) if row else None
            result.append({"slot":slot_obj(slot), "subject":{"id":slot["subject_id"],"code":slot["code"],"name":slot["subject_name"],"branch":slot["branch"],"year":slot["year"]},"teacherName":slot["teacher_name"],"record":rec,"status":row["status"] if row else "unmarked"})
        return result


@app.get("/api/teacher/assignments")
def teacher_assignments(user: sqlite3.Row = Depends(require_teacher)) -> list[dict[str, Any]]:
    with connect() as db: return sections_for_teacher(db,user["id"])


@app.get("/api/timetable")
def timetable(sectionId: str, user: sqlite3.Row = Depends(get_user)) -> list[dict[str, Any]]:
    with connect() as db:
        if user["role"] == "student":
            if student_profile(db,user)["sectionId"] != sectionId: raise HTTPException(403,"You cannot view this class timetable.")
        else:
            require_assignment(db,user["id"],sectionId)
        return [slot_obj(r) for r in db.execute("SELECT * FROM timetable_slots WHERE section_id=? ORDER BY day_of_week,start_time",(sectionId,)).fetchall()]


@app.get("/api/teacher/schedule")
def teacher_schedule(date_: str = __import__("fastapi").Query(default="", alias="date"), user: sqlite3.Row = Depends(require_teacher)) -> list[dict[str, Any]]:
    try: day=(date.fromisoformat(date_) if date_ else date.today()).isoweekday()
    except ValueError as exc: raise HTTPException(422,"Date must use YYYY-MM-DD.") from exc
    with connect() as db: return [slot_obj(r) for r in db.execute("SELECT * FROM timetable_slots WHERE teacher_id=? AND day_of_week=? ORDER BY start_time",(user["id"],day)).fetchall()]


@app.get("/api/teacher/roster")
def teacher_roster(sectionId: str, date_: str = __import__("fastapi").Query(alias="date"), slotId: str | None = None, user: sqlite3.Row = Depends(require_teacher)) -> list[dict[str, Any]]:
    try: target=date.fromisoformat(date_)
    except ValueError as exc: raise HTTPException(422,"Date must use YYYY-MM-DD.") from exc
    with connect() as db:
        require_assignment(db,user["id"],sectionId,slotId)
        if slotId and db.execute("SELECT 1 FROM timetable_slots WHERE id=? AND section_id=?",(slotId,sectionId)).fetchone() is None: raise HTTPException(404,"Period not found.")
        students=db.execute("""SELECT s.student_id,s.name FROM student_profiles p JOIN students s ON s.student_id=p.student_id
          WHERE p.section_id=? ORDER BY s.name""",(sectionId,)).fetchall()
        result=[]
        for student in students:
            q="SELECT * FROM class_attendance WHERE student_id=? AND date=?"; args: list[Any]=[student["student_id"],target.isoformat()]
            if slotId: q+=" AND slot_id=?";args.append(slotId)
            rows=db.execute(q+" ORDER BY in_time",args).fetchall()
            if not rows:
                result.append({"studentId":student["student_id"],"name":student["name"],"status":"unmarked","inTime":None,"method":None})
            else:
                for row in rows: result.append({"studentId":student["student_id"],"name":student["name"],"status":row["status"],"inTime":row["in_time"],"method":row["method"]})
        return result


@app.patch("/api/teacher/attendance")
def mark_attendance(body: MarkInput, user: sqlite3.Row = Depends(require_teacher)) -> dict[str, Any]:
    try: date.fromisoformat(body.date)
    except ValueError as exc: raise HTTPException(422,"Date must use YYYY-MM-DD.") from exc
    with connect() as db:
        require_assignment(db,user["id"],body.sectionId,body.slotId)
        slot=db.execute("SELECT * FROM timetable_slots WHERE id=? AND section_id=?",(body.slotId,body.sectionId)).fetchone()
        if slot is None: raise HTTPException(404,"Period not found.")
        if db.execute("SELECT 1 FROM student_profiles WHERE student_id=? AND section_id=?",(body.studentId,body.sectionId)).fetchone() is None: raise HTTPException(404,"Student is not in this class.")
        existing=db.execute("SELECT * FROM class_attendance WHERE student_id=? AND slot_id=? AND date=?",(body.studentId,body.slotId,body.date)).fetchone()
        row_id=existing["id"] if existing else uid()
        stamp=datetime.now().strftime("%H:%M:%S") if body.status in ("present","late") else None
        db.execute("""INSERT INTO class_attendance(id,student_id,slot_id,date,status,in_time,out_time,method,marked_by,created_at)
          VALUES (?,?,?,?,?,?,NULL,'manual',?,?) ON CONFLICT(student_id,slot_id,date) DO UPDATE SET
          status=excluded.status,in_time=excluded.in_time,method='manual',marked_by=excluded.marked_by""",
          (row_id,body.studentId,body.slotId,body.date,body.status,stamp,user["id"],now_iso()))
        row=db.execute("SELECT * FROM class_attendance WHERE id=?",(row_id,)).fetchone()
        return record_obj(row,body.sectionId,slot["subject_id"],slot["id"])


def parse_timetable(csv_text: str) -> tuple[list[dict[str, Any]], list[str]]:
    required={"day","start","end","subject_code","subject_name","section","room","teacher_email"}
    try: reader=csv.DictReader(io.StringIO(csv_text))
    except csv.Error as exc: return [],[str(exc)]
    if not reader.fieldnames or not required.issubset({x.strip().lower() for x in reader.fieldnames}):
        return [],["CSV must include: day,start,end,subject_code,subject_name,section,room,teacher_email"]
    rows=[]; errors=[]; seen=set()
    day_map={"mon":1,"monday":1,"tue":2,"tuesday":2,"wed":3,"wednesday":3,"thu":4,"thursday":4,"fri":5,"friday":5,"sat":6,"saturday":6}
    for line, raw in enumerate(reader,2):
        row={str(k).strip().lower():str(v or "").strip() for k,v in raw.items() if k is not None}
        try:
            day=day_map.get(row.get("day"," ").lower())
            start=time.fromisoformat(row["start"]); end=time.fromisoformat(row["end"])
            code=row["subject_code"].upper(); name=row["subject_name"]
            if day is None: raise ValueError("day must be Mon-Sat")
            if start >= end: raise ValueError("end must be later than start")
            if not code or not name or not row["section"]: raise ValueError("subject and section are required")
            key=(day,start.strftime("%H:%M"))
            if key in seen: raise ValueError("duplicate day and start time")
            seen.add(key)
            rows.append({"line":line,"day":day,"start":start.strftime("%H:%M"),"end":end.strftime("%H:%M"),"code":code,"name":name,"section":row["section"].upper(),"room":row["room"],"email":row["teacher_email"].lower()})
        except (ValueError,KeyError) as exc: errors.append(f"Line {line}: {exc}")
    return rows,errors


def validate_timetable(db: sqlite3.Connection, body: TimetableInput, user: sqlite3.Row) -> tuple[list[dict[str, Any]], list[str], int, int]:
    rows,errors=parse_timetable(body.csv)
    if not rows and not errors: errors.append("No timetable rows were provided.")
    require_assignment(db,user["id"],body.sectionId)
    sec=db.execute("SELECT * FROM sections WHERE id=?",(body.sectionId,)).fetchone()
    own=db.execute("SELECT email FROM users WHERE id=?",(user["id"],)).fetchone()[0].lower()
    valid=[]
    for row in rows:
        section_value=row["section"]
        if section_value not in (sec["id"],sec["section"]): errors.append(f"Line {row['line']}: section does not match {sec['id']}."); continue
        if row["email"] and row["email"]!=own: errors.append(f"Line {row['line']}: teacher_email must match your account.");continue
        subject=db.execute("SELECT * FROM subjects WHERE code=?",(row["code"],)).fetchone()
        assignment=db.execute("SELECT 1 FROM teaching_assignments WHERE teacher_id=? AND section_id=? AND subject_id=?",(user["id"],body.sectionId,row["code"])).fetchone()
        if subject is None or assignment is None: errors.append(f"Line {row['line']}: subject {row['code']} is not in your approved assignment.");continue
        valid.append(row)
    # Validate overlaps before saving; reject conflicting rows, preserve existing grid.
    for index, row in enumerate(valid):
        overlap=db.execute("""SELECT 1 FROM timetable_slots WHERE section_id=? AND day_of_week=?
          AND start_time < ? AND end_time > ? AND start_time<>?""",
          (body.sectionId,row["day"],row["end"],row["start"],row["start"])).fetchone()
        if overlap:
            errors.append(f"Line {row['line']}: period overlaps an existing class.")
            row["rejected"] = True
        for other in valid[:index]:
            if other["day"] == row["day"] and other["start"] < row["end"] and other["end"] > row["start"]:
                errors.append(f"Line {row['line']}: period overlaps another row in this upload.")
                row["rejected"] = True
                break
    valid = [row for row in valid if not row.get("rejected")]
    imported=sum(db.execute("SELECT 1 FROM timetable_slots WHERE section_id=? AND day_of_week=? AND start_time=?",(body.sectionId,r["day"],r["start"])).fetchone() is None for r in valid)
    replaced=len(valid)-imported
    return valid,errors,imported,replaced


@app.post("/api/teacher/timetable/preview")
def preview_timetable(body: TimetableInput, user: sqlite3.Row = Depends(require_teacher)) -> dict[str, Any]:
    with connect() as db:
        _,errors,imported,replaced=validate_timetable(db,body,user)
        return {"imported":imported,"replaced":replaced,"errors":errors}


@app.post("/api/teacher/timetable/upload")
def upload_timetable(body: TimetableInput, user: sqlite3.Row = Depends(require_teacher)) -> dict[str, Any]:
    with connect() as db:
        valid,errors,imported,replaced=validate_timetable(db,body,user)
        for row in valid:
            exists=db.execute("SELECT id FROM timetable_slots WHERE section_id=? AND day_of_week=? AND start_time=?",(body.sectionId,row["day"],row["start"])).fetchone()
            slot_id=exists["id"] if exists else uid()
            db.execute("""INSERT INTO timetable_slots(id,section_id,subject_id,teacher_id,day_of_week,start_time,end_time,room)
              VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(section_id,day_of_week,start_time) DO UPDATE SET subject_id=excluded.subject_id,teacher_id=excluded.teacher_id,end_time=excluded.end_time,room=excluded.room""",
              (slot_id,body.sectionId,row["code"],user["id"],row["day"],row["start"],row["end"],row["room"]))
        return {"imported":imported,"replaced":replaced,"errors":errors}


def get_department(db: sqlite3.Connection, user_id: str) -> sqlite3.Row:
    row=db.execute("""SELECT d.* FROM departments d JOIN department_members m ON m.department_id=d.id WHERE m.user_id=?""",(user_id,)).fetchone()
    if row is None: raise HTTPException(404,"You are not a member of a department.")
    return row


@app.get("/api/departments/mine")
def my_department(user: sqlite3.Row = Depends(require_teacher)) -> dict[str,Any] | None:
    with connect() as db:
        row=db.execute("SELECT d.* FROM departments d JOIN department_members m ON m.department_id=d.id WHERE m.user_id=?",(user["id"],)).fetchone()
        return department_obj(db,row) if row else None


@app.post("/api/departments")
def create_department(body: DepartmentInput,user: sqlite3.Row=Depends(require_teacher)) -> dict[str,Any]:
    with connect() as db:
        if db.execute("SELECT 1 FROM department_members WHERE user_id=?",(user["id"],)).fetchone(): raise HTTPException(409,"You already belong to a department.")
        dept_id=uid();code=secrets.token_urlsafe(24)
        try: db.execute("INSERT INTO departments(id,name,join_code_hash,created_at,hod_user_id) VALUES (?,?,?,?,?)",(dept_id,body.name.strip(),digest_token(code),now_iso(),user["id"]))
        except sqlite3.IntegrityError as exc: raise HTTPException(409,"That department name already exists.") from exc
        db.execute("UPDATE teacher_profiles SET department_id=? WHERE user_id=?",(dept_id,user["id"]))
        db.execute("INSERT INTO department_members(department_id,user_id,joined_at,role,manage_timetable,mark_attendance,enroll_students,post_announcements,view_analytics) VALUES (?,?,?,'hod',1,1,1,1,1)",(dept_id,user["id"],now_iso()))
        row=db.execute("SELECT * FROM departments WHERE id=?",(dept_id,)).fetchone()
        return department_obj(db,{**dict(row),"join_code":code})


@app.post("/api/departments/join")
def join_department(body: JoinInput,user: sqlite3.Row=Depends(require_teacher)) -> dict[str,Any]:
    with connect() as db:
        dept=db.execute("SELECT * FROM departments WHERE join_code_hash=?",(digest_token(body.code),)).fetchone()
        if dept is None: raise HTTPException(404,"Department invitation code is invalid.")
        existing=db.execute("SELECT department_id FROM department_members WHERE user_id=?",(user["id"],)).fetchone()
        if existing and existing["department_id"]!=dept["id"]: raise HTTPException(409,"You already belong to another department.")
        db.execute("INSERT OR IGNORE INTO department_members(department_id,user_id,joined_at) VALUES (?,?,?)",(dept["id"],user["id"],now_iso()))
        db.execute("UPDATE teacher_profiles SET department_id=? WHERE user_id=?",(dept["id"],user["id"]))
        return department_obj(db,dept)


@app.post("/api/departments/code/rotate")
def rotate_department_code(user: sqlite3.Row=Depends(require_teacher)) -> dict[str,Any]:
    code=secrets.token_urlsafe(24)
    with connect() as db:
        dept=get_department(db,user["id"])
        if dept["hod_user_id"]!=user["id"]: raise HTTPException(403,"Only the department lead can rotate its invitation code.")
        db.execute("UPDATE departments SET join_code_hash=? WHERE id=?",(digest_token(code),dept["id"]))
        row=db.execute("SELECT * FROM departments WHERE id=?",(dept["id"],)).fetchone()
        return department_obj(db,{**dict(row),"join_code":code})


def dept_member_obj(db: sqlite3.Connection, dept_id: str, row: sqlite3.Row) -> dict[str,Any]:
    assignments=db.execute("SELECT DISTINCT section_id FROM teaching_assignments WHERE teacher_id=? ORDER BY section_id",(row["user_id"],)).fetchall()
    return {"userId":row["user_id"],"name":row["name"],"email":row["email"],"role":"hod" if row["role"]=="hod" else "admin",
      "joinedAt":row["joined_at"],"permissions":{"manageTimetable":bool(row["manage_timetable"]),"markAttendance":bool(row["mark_attendance"]),"enrollStudents":bool(row["enroll_students"]),"postAnnouncements":bool(row["post_announcements"]),"viewAnalytics":bool(row["view_analytics"])},"assignedSections":[a["section_id"] for a in assignments]}


@app.get("/api/departments/members")
def department_members(user: sqlite3.Row=Depends(require_teacher)) -> list[dict[str,Any]]:
    with connect() as db:
        dept=get_department(db,user["id"])
        rows=db.execute("""SELECT m.*,u.name,u.email FROM department_members m JOIN users u ON u.id=m.user_id
          WHERE m.department_id=? ORDER BY m.role DESC,u.name""",(dept["id"],)).fetchall()
        return [dept_member_obj(db,dept["id"],r) for r in rows]


@app.patch("/api/departments/members/{member_id}/permissions")
def set_permissions(member_id: str,body: PermissionInput,user: sqlite3.Row=Depends(require_teacher)) -> dict[str,Any]:
    mapping={"manageTimetable":"manage_timetable","markAttendance":"mark_attendance","enrollStudents":"enroll_students","postAnnouncements":"post_announcements","viewAnalytics":"view_analytics"}
    if set(body.permissions)!=set(mapping): raise HTTPException(422,"Provide all department permissions.")
    with connect() as db:
        dept=get_department(db,user["id"])
        if dept["hod_user_id"]!=user["id"]: raise HTTPException(403,"Only the department lead can change permissions.")
        if db.execute("SELECT 1 FROM department_members WHERE department_id=? AND user_id=?",(dept["id"],member_id)).fetchone() is None: raise HTTPException(404,"Department member not found.")
        db.execute("UPDATE department_members SET "+",".join(f"{column}=?" for column in mapping.values())+" WHERE department_id=? AND user_id=?",tuple(int(body.permissions[key]) for key in mapping)+(dept["id"],member_id))
        row=db.execute("SELECT m.*,u.name,u.email FROM department_members m JOIN users u ON u.id=m.user_id WHERE m.department_id=? AND m.user_id=?",(dept["id"],member_id)).fetchone()
        return dept_member_obj(db,dept["id"],row)


def post_obj(db: sqlite3.Connection,row: sqlite3.Row) -> dict[str,Any]:
    author=db.execute("SELECT name FROM users WHERE id=?",(row["author_id"],)).fetchone()
    claimed=db.execute("SELECT name FROM users WHERE id=?",(row["claimed_by"],)).fetchone() if row["claimed_by"] else None
    return {"id":row["id"],"deptId":row["department_id"],"authorUserId":row["author_id"],"authorName":author["name"] if author else "",
      "kind":row["kind"],"title":row["title"],"body":row["body"],"createdAt":row["created_at"],"status":row["status"],
      "claimedByUserId":row["claimed_by"],"claimedByName":claimed["name"] if claimed else None,"relatedSlotId":row["related_slot_id"],"relatedDate":row["related_date"]}


@app.get("/api/departments/posts")
def department_posts(user: sqlite3.Row=Depends(require_teacher)) -> list[dict[str,Any]]:
    with connect() as db:
        dept=get_department(db,user["id"])
        return [post_obj(db,r) for r in db.execute("SELECT * FROM department_posts WHERE department_id=? ORDER BY created_at DESC",(dept["id"],)).fetchall()]


@app.post("/api/departments/posts")
def create_post(body: PostInput,user: sqlite3.Row=Depends(require_teacher)) -> dict[str,Any]:
    with connect() as db:
        dept=get_department(db,user["id"])
        member=db.execute("SELECT post_announcements FROM department_members WHERE department_id=? AND user_id=?",(dept["id"],user["id"])).fetchone()
        if body.kind=="announcement" and not member["post_announcements"]: raise HTTPException(403,"You cannot publish department announcements.")
        if body.relatedDate:
            try: date.fromisoformat(body.relatedDate)
            except ValueError as exc: raise HTTPException(422,"Related date must use YYYY-MM-DD.") from exc
        post_id=uid()
        db.execute("INSERT INTO department_posts(id,department_id,author_id,kind,title,body,created_at,related_slot_id,related_date) VALUES (?,?,?,?,?,?,?,?,?)",(post_id,dept["id"],user["id"],body.kind,body.title.strip(),body.body.strip(),now_iso(),body.relatedSlotId,body.relatedDate))
        return post_obj(db,db.execute("SELECT * FROM department_posts WHERE id=?",(post_id,)).fetchone())


def reply_obj(db: sqlite3.Connection, row: sqlite3.Row) -> dict[str,Any]:
    author=db.execute("SELECT name FROM users WHERE id=?",(row["author_id"],)).fetchone()
    return {"id":row["id"],"postId":row["post_id"],"authorUserId":row["author_id"],
      "authorName":author["name"] if author else "","body":row["body"],"createdAt":row["created_at"]}


@app.get("/api/departments/posts/{post_id}/replies")
def list_replies(post_id: str,user: sqlite3.Row=Depends(require_teacher)) -> list[dict[str,Any]]:
    with connect() as db:
        dept=get_department(db,user["id"])
        if db.execute("SELECT 1 FROM department_posts WHERE id=? AND department_id=?",(post_id,dept["id"])).fetchone() is None:
            raise HTTPException(404,"Discussion not found.")
        return [reply_obj(db,r) for r in db.execute("SELECT * FROM department_replies WHERE post_id=? ORDER BY created_at",(post_id,)).fetchall()]


@app.post("/api/departments/posts/{post_id}/replies")
def create_reply(post_id: str,body: ReplyInput,user: sqlite3.Row=Depends(require_teacher)) -> dict[str,Any]:
    with connect() as db:
        dept=get_department(db,user["id"])
        if db.execute("SELECT 1 FROM department_posts WHERE id=? AND department_id=?",(post_id,dept["id"])).fetchone() is None:
            raise HTTPException(404,"Discussion not found.")
        reply_id=uid()
        db.execute("INSERT INTO department_replies(id,post_id,department_id,author_id,body,created_at) VALUES (?,?,?,?,?,?)",
          (reply_id,post_id,dept["id"],user["id"],body.body.strip(),now_iso()))
        return reply_obj(db,db.execute("SELECT * FROM department_replies WHERE id=?",(reply_id,)).fetchone())


def mutate_post(post_id: str,user: sqlite3.Row,claim: bool) -> dict[str,Any]:
    with connect() as db:
        dept=get_department(db,user["id"])
        post=db.execute("SELECT * FROM department_posts WHERE id=? AND department_id=?",(post_id,dept["id"])).fetchone()
        if post is None: raise HTTPException(404,"Discussion not found.")
        if claim:
            if post["kind"]!="coverage_request": raise HTTPException(400,"Only coverage requests can be claimed.")
            if post["status"]!="open": raise HTTPException(409,"This request is already resolved.")
            db.execute("UPDATE department_posts SET claimed_by=? WHERE id=?",(user["id"],post_id))
        else:
            if post["author_id"]!=user["id"] and dept["hod_user_id"]!=user["id"]: raise HTTPException(403,"Only the author or department lead can resolve this request.")
            db.execute("UPDATE department_posts SET status='resolved' WHERE id=?",(post_id,))
        return post_obj(db,db.execute("SELECT * FROM department_posts WHERE id=?",(post_id,)).fetchone())


@app.post("/api/departments/posts/{post_id}/claim")
def claim_post(post_id: str,user: sqlite3.Row=Depends(require_teacher)) -> dict[str,Any]: return mutate_post(post_id,user,True)


@app.post("/api/departments/posts/{post_id}/resolve")
def resolve_post(post_id: str,user: sqlite3.Row=Depends(require_teacher)) -> dict[str,Any]: return mutate_post(post_id,user,False)


@app.get("/api/departments/analytics")
def department_analytics(user: sqlite3.Row=Depends(require_teacher)) -> list[dict[str,Any]]:
    with connect() as db:
        dept=get_department(db,user["id"])
        member=db.execute("SELECT view_analytics FROM department_members WHERE department_id=? AND user_id=?",(dept["id"],user["id"])).fetchone()
        if not member["view_analytics"]: raise HTTPException(403,"Department analytics access is not enabled for you.")
        rows=db.execute("""SELECT ts.section_id, su.id subject_id, su.code, su.name,
          COUNT(DISTINCT ca.date||':'||ca.slot_id) sessions,COUNT(*) marked,
          SUM(ca.status IN ('present','late')) present
          FROM class_attendance ca JOIN timetable_slots ts ON ts.id=ca.slot_id JOIN subjects su ON su.id=ts.subject_id
          JOIN teaching_assignments a ON a.section_id=ts.section_id JOIN teacher_profiles tp ON tp.department_id=? AND tp.user_id=a.teacher_id
          GROUP BY ts.section_id,su.id""",(dept["id"],)).fetchall()
        result=[]
        for r in rows:
            strength=db.execute("SELECT COUNT(*) FROM student_profiles WHERE section_id=?",(r["section_id"],)).fetchone()[0]
            complete=bool(strength and r["sessions"] and r["marked"] >= strength*r["sessions"])
            at_risk=None
            if complete:
                per_student=db.execute("""SELECT student_id,COUNT(*) held,
                  SUM(status IN ('present','late')) attended,SUM(status='excused') excused
                  FROM class_attendance ca JOIN timetable_slots ts ON ts.id=ca.slot_id
                  WHERE ts.section_id=? AND ts.subject_id=? GROUP BY student_id""",(r["section_id"],r["subject_id"])).fetchall()
                at_risk=sum(1 for student in per_student if student["held"]>student["excused"] and
                  student["attended"]/(student["held"]-student["excused"]) < ATTENDANCE_THRESHOLD/100)
            result.append({"sectionId":r["section_id"],"subjectCode":r["code"],"subjectName":r["name"],
              "sessionsHeld":r["sessions"],"presentRate":round(100*r["present"]/r["marked"],1) if complete else None,
              "atRiskCount":at_risk,"strength":strength})
        return result


@app.post("/api/student/enrollment")
def enroll_face(body: dict[str,str],user: sqlite3.Row=Depends(get_user)) -> dict[str,int]:
    if user["role"]!="student": raise HTTPException(403,"Student access is required.")
    data_url=body.get("image","")
    if len(data_url)>3_000_000: raise HTTPException(413,"Image must be smaller than 2 MB.")
    try:
        encoded=data_url.split(",",1)[1] if data_url.startswith("data:image/") and ";base64," in data_url else ""
        raw=base64.b64decode(encoded,validate=True)
    except (ValueError,IndexError) as exc: raise HTTPException(422,"Provide a valid camera image.") from exc
    if not raw or len(raw)>2_000_000: raise HTTPException(422,"Provide a valid image smaller than 2 MB.")
    image=cv2.imdecode(np.frombuffer(raw,dtype=np.uint8),cv2.IMREAD_COLOR)
    if image is None: raise HTTPException(422,"The uploaded image could not be read.")
    if not MODEL_DETECT.is_file() or not MODEL_RECOGNIZE.is_file(): raise HTTPException(503,"Face recognition models are not installed.")
    detector=cv2.FaceDetectorYN.create(str(MODEL_DETECT),"",(320,320),0.8,0.3,5000)
    detector.setInputSize((image.shape[1],image.shape[0]))
    _,faces=detector.detect(image)
    if faces is None or len(faces)!=1: raise HTTPException(422,"Place exactly one face in the camera frame.")
    recognizer=cv2.FaceRecognizerSF.create(str(MODEL_RECOGNIZE),"")
    try: embedding=recognizer.feature(recognizer.alignCrop(image,max(faces,key=lambda f:f[2]*f[3]))).astype(np.float32)
    except cv2.error as exc: raise HTTPException(422,"Could not create a face embedding from this frame.") from exc
    norm=float(np.linalg.norm(embedding))
    if norm==0: raise HTTPException(422,"Could not create a valid face embedding.")
    embedding=(embedding/norm).astype(np.float32).tobytes()
    with connect() as db:
        profile=student_profile(db,user)
        existing=db.execute("SELECT length(embedding) size FROM students WHERE student_id=?",(profile["studentId"],)).fetchone()
        if existing is None: raise HTTPException(404,"No attendance identity is registered for this account.")
        if existing["size"]: raise HTTPException(409,"Your face is already enrolled. Contact an authorized operator if it needs to be re-enrolled.")
        db.execute("UPDATE students SET embedding=? WHERE student_id=?",(embedding,profile["studentId"]))
        db.execute("DELETE FROM student_embeddings WHERE student_id=?",(profile["studentId"],))
        return {"harvestedReferences":0}


@app.exception_handler(sqlite3.IntegrityError)
async def integrity_error(_request, exc: sqlite3.IntegrityError):
    return __import__("fastapi").responses.JSONResponse(status_code=409,content={"detail":"The requested change conflicts with existing data."})
