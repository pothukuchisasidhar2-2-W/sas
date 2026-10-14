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
import re
import secrets
import smtplib
import sqlite3
import ssl
import uuid
from email.message import EmailMessage
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
SESSION_DAYS = 30
OTP_MINUTES = 10
ATTENDANCE_THRESHOLD = float(os.environ.get("TRUE_EYE_ATTENDANCE_THRESHOLD", "75"))
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
SAHE_INSTITUTION_NAME = "Siddhartha Academy of Higher Education"


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
  name TEXT NOT NULL, created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  google_sub TEXT, college_name TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS api_sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_sessions_user ON api_sessions(user_id);
CREATE TABLE IF NOT EXISTS email_codes (
  email TEXT NOT NULL COLLATE NOCASE, purpose TEXT NOT NULL CHECK(purpose IN ('signup','reset')),
  code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(email,purpose)
);
CREATE TABLE IF NOT EXISTS google_login_nonces (
  nonce_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL
);
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
  section_id TEXT NOT NULL REFERENCES sections(id), joined_at TEXT NOT NULL,
  enrollment_status TEXT NOT NULL DEFAULT 'approved' CHECK(enrollment_status IN ('pending','approved','rejected'))
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
CREATE TABLE IF NOT EXISTS timetable_exceptions (
  id TEXT PRIMARY KEY, date TEXT NOT NULL, section_id TEXT NOT NULL REFERENCES sections(id),
  slot_id TEXT NOT NULL REFERENCES timetable_slots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('cancel','modify','add')),
  start_time TEXT, end_time TEXT, room TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE(date,slot_id)
);
CREATE INDEX IF NOT EXISTS idx_timetable_exceptions_date ON timetable_exceptions(date,section_id);
CREATE TABLE IF NOT EXISTS class_attendance (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(student_id),
  slot_id TEXT NOT NULL REFERENCES timetable_slots(id), date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('present','absent','late','excused')),
  in_time TEXT, out_time TEXT, method TEXT NOT NULL CHECK(method IN ('face','manual')),
  marked_by TEXT REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE(student_id,slot_id,date)
);
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id TEXT PRIMARY KEY, section_id TEXT NOT NULL REFERENCES sections(id),
  slot_id TEXT NOT NULL REFERENCES timetable_slots(id), date TEXT NOT NULL,
  completed_by TEXT NOT NULL REFERENCES users(id), completed_at TEXT NOT NULL,
  UNIQUE(slot_id,date)
);
CREATE TABLE IF NOT EXISTS camera_runs (
  camera_id TEXT NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN ('entry','exit')),
  section_id TEXT NOT NULL REFERENCES sections(id), slot_id TEXT NOT NULL REFERENCES timetable_slots(id),
  date TEXT NOT NULL, started_at TEXT NOT NULL, last_heartbeat_at TEXT NOT NULL,
  heartbeat_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(camera_id,event_type,slot_id,date)
);
CREATE TABLE IF NOT EXISTS camera_attendance_events (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(student_id),
  slot_id TEXT NOT NULL REFERENCES timetable_slots(id), date TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('entry','exit')),
  camera_id TEXT NOT NULL, observed_at TEXT NOT NULL, score REAL NOT NULL,
  UNIQUE(student_id,slot_id,date,event_type,camera_id)
);
CREATE INDEX IF NOT EXISTS idx_camera_events_period ON camera_attendance_events(slot_id,date);
CREATE TABLE IF NOT EXISTS camera_attendance_reviews (
  student_id TEXT NOT NULL REFERENCES students(student_id),
  slot_id TEXT NOT NULL REFERENCES timetable_slots(id), date TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('early_exit','not_observed')),
  flagged_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT REFERENCES users(id),
  PRIMARY KEY(student_id,slot_id,date)
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
        user_columns = {row["name"] for row in db.execute("PRAGMA table_info(users)")}
        if "google_sub" not in user_columns:
            db.execute("ALTER TABLE users ADD COLUMN google_sub TEXT")
        if "college_name" not in user_columns:
            db.execute("ALTER TABLE users ADD COLUMN college_name TEXT NOT NULL DEFAULT ''")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL")
        profile_columns = {row["name"] for row in db.execute("PRAGMA table_info(student_profiles)")}
        if "enrollment_status" not in profile_columns:
            # Existing profiles predate teacher review and retain access.
            db.execute("ALTER TABLE student_profiles ADD COLUMN enrollment_status TEXT NOT NULL DEFAULT 'approved'")
        exception_columns = {row["name"] for row in db.execute("PRAGMA table_info(timetable_exceptions)")}
        if "cancelled" not in exception_columns:
            db.execute("ALTER TABLE timetable_exceptions ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0")
        db.execute("""INSERT OR IGNORE INTO attendance_sessions
            (id,section_id,slot_id,date,completed_by,completed_at)
            SELECT lower(hex(randomblob(16))),ts.section_id,ca.slot_id,ca.date,ts.teacher_id,MAX(ca.created_at)
            FROM class_attendance ca JOIN timetable_slots ts ON ts.id=ca.slot_id
            JOIN student_profiles sp ON sp.student_id=ca.student_id
              AND sp.section_id=ts.section_id AND sp.enrollment_status='approved'
            GROUP BY ts.section_id,ca.slot_id,ca.date
            HAVING COUNT(DISTINCT ca.student_id)>0 AND COUNT(DISTINCT ca.student_id)=(
              SELECT COUNT(*) FROM student_profiles approved
              WHERE approved.section_id=ts.section_id AND approved.enrollment_status='approved'
            )""")
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


def verify_google_credential(credential: str, nonce: str) -> dict[str, str]:
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(503, "Google sign-in is not configured on the API server.")
    try:
        from google.auth.transport.requests import Request as GoogleAuthRequest
        from google.oauth2 import id_token as google_id_token

        claims = google_id_token.verify_oauth2_token(
            credential, GoogleAuthRequest(), GOOGLE_CLIENT_ID,
        )
    except ImportError:
        raise HTTPException(503, "Install API requirements to enable Google sign-in.")
    except ValueError:
        raise HTTPException(401, "Google sign-in could not be verified. Try again.")
    except Exception:
        raise HTTPException(502, "Google sign-in verification is temporarily unavailable.")
    if claims.get("nonce") != nonce:
        raise HTTPException(401, "Google sign-in expired. Try again.")
    with connect() as db:
        valid_nonce = db.execute("SELECT 1 FROM google_login_nonces WHERE nonce_hash=? AND expires_at>?",
                                 (digest_token(nonce), now_iso())).fetchone()
    if valid_nonce is None:
        raise HTTPException(401, "Google sign-in expired. Try again.")
    if not claims.get("email_verified"):
        raise HTTPException(403, "Use a Google account with a verified email address.")
    subject = str(claims.get("sub", "")).strip()
    email = str(claims.get("email", "")).strip().lower()
    name = str(claims.get("name", "")).strip()[:120]
    if not subject or "@" not in email or not name:
        raise HTTPException(401, "Google did not provide the required verified account details.")
    return {"sub": subject, "email": email, "name": name}


def consume_google_nonce(nonce: str) -> None:
    with connect() as db:
        changed = db.execute("DELETE FROM google_login_nonces WHERE nonce_hash=? AND expires_at>?",
                             (digest_token(nonce), now_iso())).rowcount
        if changed != 1:
            raise HTTPException(401, "Google sign-in expired or was already used. Try again.")


class LoginInput(BaseModel):
    email: str = Field(min_length=3, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    password: str = Field(min_length=8, max_length=256)


class EmailInput(BaseModel):
    email: str = Field(min_length=3, max_length=254)


class ResetPasswordInput(EmailInput):
    code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")
    password: str = Field(min_length=8, max_length=256)


class StudentSignup(LoginInput):
    emailCode: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")
    name: str = Field(min_length=1, max_length=120)
    branch: str = Field(min_length=1, max_length=32)
    year: int = Field(ge=1, le=8)
    section: str = Field(min_length=1, max_length=16)
    studentId: str = Field(min_length=1, max_length=64)


class TeacherSignup(LoginInput):
    emailCode: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")
    name: str = Field(min_length=1, max_length=120)
    departmentName: str = Field(default="", max_length=100)
    inviteCode: str = Field(min_length=16, max_length=128)
    assignments: list[dict[str, Any]] = Field(default_factory=list)


class GoogleCredentialInput(BaseModel):
    credential: str = Field(min_length=32, max_length=8192)
    nonce: str = Field(min_length=16, max_length=128)


class GoogleStudentSignup(GoogleCredentialInput):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=256)
    branch: str = Field(min_length=1, max_length=32)
    year: int = Field(ge=1, le=8)
    section: str = Field(min_length=1, max_length=16)
    studentId: str = Field(min_length=1, max_length=64)


class GoogleTeacherSignup(GoogleCredentialInput):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=256)
    inviteCode: str = Field(min_length=16, max_length=128)


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


class CompleteAttendanceInput(BaseModel):
    sectionId: str
    slotId: str
    date: str


class TimetableInput(BaseModel):
    sectionId: str
    csv: str = Field(min_length=1, max_length=1_000_000)


class TimetableChangeInput(BaseModel):
    date: str
    sectionId: str
    kind: str = Field(pattern="^(cancel|modify|add)$")
    slotId: str | None = None
    subjectId: str | None = None
    startTime: str | None = None
    endTime: str | None = None
    room: str | None = Field(default=None, max_length=100)


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
    row = db.execute("""SELECT sp.*,s.branch,s.year,s.section,s.id section_id,u.name,u.email,u.college_name
      FROM student_profiles sp JOIN sections s ON s.id=sp.section_id
      JOIN users u ON u.id=sp.user_id WHERE sp.user_id=?""", (user["id"],)).fetchone()
    if row is None:
        raise HTTPException(404, "Student profile is not available.")
    embeddings = db.execute("SELECT COUNT(*) FROM student_embeddings WHERE student_id=?", (row["student_id"],)).fetchone()[0]
    enrolled = db.execute("SELECT 1 FROM students WHERE student_id=? AND length(embedding)>0", (row["student_id"],)).fetchone() is not None
    return {"studentId": row["student_id"], "userId": row["user_id"], "name": row["name"], "email": row["email"], "collegeName": row["college_name"],
            "branch": row["branch"], "year": row["year"], "section": row["section"], "sectionId": row["section_id"],
            "faceEnrolled": enrolled, "harvestedReferences": embeddings, "joinedAt": row["joined_at"],
            "enrollmentStatus": row["enrollment_status"]}


def require_approved_student(db: sqlite3.Connection, user: sqlite3.Row) -> None:
    row = db.execute("SELECT enrollment_status FROM student_profiles WHERE user_id=?", (user["id"],)).fetchone()
    if row is None:
        raise HTTPException(404, "Student profile is not available.")
    if row["enrollment_status"] != "approved":
        raise HTTPException(403, "Your class membership is awaiting teacher approval.")


def teacher_profile(db: sqlite3.Connection, user: sqlite3.Row) -> dict[str, Any]:
    profile = db.execute("""SELECT tp.department_id,d.name department_name,u.college_name FROM teacher_profiles tp
      JOIN users u ON u.id=tp.user_id LEFT JOIN departments d ON d.id=tp.department_id WHERE tp.user_id=?""", (user["id"],)).fetchone()
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
      "departmentName": profile["department_name"] if profile else None,
      "collegeName": profile["college_name"] if profile else "", "isHod": is_hod, "assignments": assignments}


def session_user(db: sqlite3.Connection, user: sqlite3.Row) -> dict[str, Any]:
    if user["role"] == "student":
        return {"role": "student", "profile": student_profile(db, user)}
    return {"role": "teacher", "profile": teacher_profile(db, user)}


def make_session(db: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    token = secrets.token_urlsafe(36)
    db.execute("INSERT INTO api_sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)",
      (digest_token(token), user_id, (datetime.now(timezone.utc)+timedelta(days=SESSION_DAYS)).replace(microsecond=0).isoformat(), now_iso()))
    row = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return {"token": token, "user": session_user(db, row)}


def gmail_address(value: str) -> str:
    email = value.strip().lower()
    local = email[:-10] if email.endswith("@gmail.com") else ""
    if (not local or len(local) > 64 or email.count("@") != 1 or len(email) > 254
        or local.startswith(".") or local.endswith(".") or ".." in local
        or any(not (char.isalnum() or char in ".!#$%&'*+/=?^_`{|}~-") for char in local)):
        raise HTTPException(422, "Use a valid @gmail.com address so we can verify your inbox.")
    return email


def verified_email_address(value: str) -> str:
    email = value.strip().lower()
    valid = (len(email) <= 254 and email.count("@") == 1
             and re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", email)
             and not email.split("@", 1)[0].startswith(".")
             and not email.split("@", 1)[0].endswith(".")
             and ".." not in email.split("@", 1)[0])
    if not valid:
        raise HTTPException(422, "Enter a valid email address.")
    return email


def send_email_code(email: str, purpose: str) -> None:
    sender = os.environ.get("TRUE_EYE_GMAIL_ADDRESS", "").strip()
    app_password = os.environ.get("TRUE_EYE_GMAIL_APP_PASSWORD", "").replace(" ", "")
    if not sender or not app_password:
        raise HTTPException(503, "Email verification is not configured. Set TRUE_EYE_GMAIL_ADDRESS and TRUE_EYE_GMAIL_APP_PASSWORD on the API server.")
    code = f"{secrets.randbelow(1_000_000):06d}"
    with connect() as db:
        prior = db.execute("SELECT created_at FROM email_codes WHERE email=? AND purpose=?", (email,purpose)).fetchone()
        if prior:
            try:
                sent = datetime.fromisoformat(prior["created_at"])
                if datetime.now(timezone.utc) - sent < timedelta(seconds=60):
                    raise HTTPException(429, "Wait a minute before requesting another code.")
            except ValueError:
                pass
        db.execute("INSERT INTO email_codes(email,purpose,code_hash,expires_at,created_at,attempts) VALUES (?,?,?,?,?,0) ON CONFLICT(email,purpose) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,created_at=excluded.created_at,attempts=0",
          (email,purpose,digest_token(code),(datetime.now(timezone.utc)+timedelta(minutes=OTP_MINUTES)).replace(microsecond=0).isoformat(),now_iso()))
    message = EmailMessage()
    message["Subject"] = "True Eye email verification code" if purpose == "signup" else "True Eye password reset code"
    message["From"] = sender
    message["To"] = email
    message.set_content(f"Your True Eye code is {code}. It expires in {OTP_MINUTES} minutes. If you did not request this, ignore this email.")
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context(), timeout=15) as smtp:
            smtp.login(sender, app_password)
            smtp.send_message(message)
    except (OSError, smtplib.SMTPException):
        with connect() as db:
            db.execute("DELETE FROM email_codes WHERE email=? AND purpose=?", (email,purpose))
        raise HTTPException(502, "Could not send the email code. Check Gmail SMTP settings and try again.")


def consume_email_code(db: sqlite3.Connection, email: str, purpose: str, code: str) -> None:
    row = db.execute("SELECT * FROM email_codes WHERE email=? AND purpose=?", (email,purpose)).fetchone()
    if row is None or row["expires_at"] <= now_iso() or row["attempts"] >= 5:
        raise HTTPException(400, "The code is invalid or expired. Request a new one.")
    if not hmac.compare_digest(row["code_hash"], digest_token(code)):
        attempts = row["attempts"] + 1
        if attempts >= 5:
            db.execute("DELETE FROM email_codes WHERE email=? AND purpose=?", (email,purpose))
        else:
            db.execute("UPDATE email_codes SET attempts=? WHERE email=? AND purpose=?", (attempts,email,purpose))
        # Keep failed guesses across the HTTP error rollback in connect().
        db.commit()
        raise HTTPException(400, "The code is invalid or expired. Request a new one.")
    db.execute("DELETE FROM email_codes WHERE email=? AND purpose=?", (email,purpose))


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


@app.post("/api/auth/google/identity")
def google_identity(body: GoogleCredentialInput) -> dict[str, str]:
    identity = verify_google_credential(body.credential, body.nonce)
    return {"name": identity["name"], "email": identity["email"]}


@app.post("/api/auth/google/nonce")
def google_nonce() -> dict[str, str]:
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(503, "Google sign-in is not configured on the API server.")
    nonce = secrets.token_urlsafe(32)
    expires = (datetime.now(timezone.utc) + timedelta(minutes=15)).replace(microsecond=0).isoformat()
    with connect() as db:
        db.execute("DELETE FROM google_login_nonces WHERE expires_at<=?", (now_iso(),))
        db.execute("INSERT INTO google_login_nonces(nonce_hash,expires_at) VALUES (?,?)",
                   (digest_token(nonce), expires))
    return {"nonce": nonce}


@app.post("/api/auth/google/login")
def google_login(body: GoogleCredentialInput) -> dict[str, Any]:
    identity = verify_google_credential(body.credential, body.nonce)
    consume_google_nonce(body.nonce)
    with connect() as db:
        user = db.execute("SELECT * FROM users WHERE google_sub=?", (identity["sub"],)).fetchone()
        if user is None:
            user = db.execute("SELECT * FROM users WHERE email=? COLLATE NOCASE", (identity["email"],)).fetchone()
            if user is None:
                raise HTTPException(404, "No True Eye account uses this Google account yet. Create an account first.")
            if user["google_sub"] and user["google_sub"] != identity["sub"]:
                raise HTTPException(409, "This email is already connected to a different Google account.")
            db.execute("UPDATE users SET google_sub=? WHERE id=?", (identity["sub"], user["id"]))
            user = db.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
        if not user["active"]:
            raise HTTPException(403, "This account is disabled. Contact your institution.")
        return make_session(db, user["id"])


@app.post("/api/auth/signup/code", status_code=202)
def signup_code(body: EmailInput) -> dict[str, str]:
    email = gmail_address(body.email)
    with connect() as db:
        if db.execute("SELECT 1 FROM users WHERE email=? COLLATE NOCASE", (email,)).fetchone():
            raise HTTPException(409, "An account already uses that email address.")
    send_email_code(email, "signup")
    return {"message": "If this Gmail can be used, a verification code has been sent."}


@app.post("/api/auth/password-reset/code", status_code=202)
def password_reset_code(body: EmailInput) -> dict[str, str]:
    email = gmail_address(body.email)
    with connect() as db:
        exists = db.execute("SELECT 1 FROM users WHERE email=? COLLATE NOCASE AND active=1", (email,)).fetchone()
    if exists:
        send_email_code(email, "reset")
    return {"message": "If an account uses that Gmail, a password reset code has been sent."}


@app.post("/api/auth/password-reset")
def password_reset(body: ResetPasswordInput) -> dict[str, str]:
    email = gmail_address(body.email)
    with connect() as db:
        consume_email_code(db, email, "reset", body.code)
        user = db.execute("SELECT id FROM users WHERE email=? COLLATE NOCASE AND active=1", (email,)).fetchone()
        if user is None:
            raise HTTPException(400, "The code is invalid or expired. Request a new one.")
        db.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_secret(body.password), user["id"]))
        db.execute("DELETE FROM api_sessions WHERE user_id=?", (user["id"],))
    return {"message": "Password updated. Sign in with your new password."}


def signup_common(body: StudentSignup | TeacherSignup, role: str) -> dict[str, Any]:
    email = gmail_address(body.email)
    with connect() as db:
        payload = consume_invite(db, body.inviteCode, role) if role == "teacher" else {}
        if db.execute("SELECT 1 FROM users WHERE email=? COLLATE NOCASE", (email,)).fetchone():
            raise HTTPException(409, "An account already uses that email address.")
        consume_email_code(db, email, "signup", body.emailCode)
        user_id = uid()
        db.execute("INSERT INTO users(id,email,password_hash,role,name,created_at) VALUES (?,?,?,?,?,?)",
                   (user_id, email, hash_secret(body.password), role, body.name.strip(), now_iso()))
        if role == "student":
            assert isinstance(body, StudentSignup)
            sid = body.studentId.strip()
            if not sid:
                raise HTTPException(422, "Enter your student or roll number.")
            profile_exists = db.execute("SELECT 1 FROM student_profiles WHERE student_id=?", (sid,)).fetchone()
            if profile_exists:
                raise HTTPException(409, "That roll number already has a True Eye account.")
            db.execute("INSERT OR IGNORE INTO students(student_id,name,embedding) VALUES (?,?,?)", (sid, body.name.strip(), b""))
            branch = body.branch.strip().upper()
            year = int(body.year)
            section = body.section.strip().upper()
            section_id = f"{branch}-{year}-{section}"
            db.execute("INSERT OR IGNORE INTO sections(id,branch,year,section) VALUES (?,?,?,?)", (section_id, branch, year, section))
            db.execute("INSERT INTO student_profiles(user_id,student_id,section_id,joined_at,enrollment_status) VALUES (?,?,?,?,'pending')",
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
        if role == "teacher":
            db.execute("UPDATE activation_invites SET used_at=? WHERE code_hash=?", (now_iso(), digest_token(body.inviteCode)))
        return make_session(db, user_id)


@app.post("/api/auth/signup/student")
def signup_student(body: StudentSignup) -> dict[str, Any]:
    return signup_common(body, "student")


@app.post("/api/auth/signup/teacher")
def signup_teacher(body: TeacherSignup) -> dict[str, Any]:
    return signup_common(body, "teacher")


@app.post("/api/auth/google/signup/student")
def google_signup_student(body: GoogleStudentSignup) -> dict[str, Any]:
    identity = verify_google_credential(body.credential, body.nonce)
    consume_google_nonce(body.nonce)
    email = verified_email_address(body.email)
    if email != identity["email"].lower():
        raise HTTPException(400, "Verify the same email address you entered in the signup form.")
    branch, section = body.branch.strip().upper(), body.section.strip().upper()
    if not branch or not section or not body.studentId.strip():
        raise HTTPException(422, "Enter your roll number, programme, year, and class section.")
    with connect() as db:
        if db.execute("SELECT 1 FROM users WHERE email=? COLLATE NOCASE", (identity["email"],)).fetchone():
            raise HTTPException(409, "An account already uses this Google email. Sign in instead.")
        sid = body.studentId.strip()
        if db.execute("SELECT 1 FROM student_profiles WHERE student_id=?", (sid,)).fetchone():
            raise HTTPException(409, "That roll number already has a True Eye account.")
        user_id = uid()
        db.execute("INSERT INTO users(id,email,password_hash,role,name,created_at,google_sub,college_name) VALUES (?,?,?,?,?,?,?,?)",
                   (user_id, email, hash_secret(body.password), "student",
                    body.name.strip(), now_iso(), identity["sub"], SAHE_INSTITUTION_NAME))
        db.execute("INSERT OR IGNORE INTO students(student_id,name,embedding) VALUES (?,?,?)",
                   (sid, body.name.strip(), b""))
        section_id = f"{branch}-{body.year}-{section}"
        db.execute("INSERT OR IGNORE INTO sections(id,branch,year,section) VALUES (?,?,?,?)",
                   (section_id, branch, body.year, section))
        db.execute("INSERT INTO student_profiles(user_id,student_id,section_id,joined_at,enrollment_status) VALUES (?,?,?,?,'pending')",
                   (user_id, sid, section_id, now_iso()))
        return make_session(db, user_id)


@app.post("/api/auth/google/signup/teacher")
def google_signup_teacher(body: GoogleTeacherSignup) -> dict[str, Any]:
    identity = verify_google_credential(body.credential, body.nonce)
    consume_google_nonce(body.nonce)
    email = verified_email_address(body.email)
    if email != identity["email"].lower():
        raise HTTPException(400, "Verify the same email address you entered in the signup form.")
    with connect() as db:
        payload = consume_invite(db, body.inviteCode, "teacher")
        if db.execute("SELECT 1 FROM users WHERE email=? COLLATE NOCASE", (identity["email"],)).fetchone():
            raise HTTPException(409, "An account already uses this Google email. Sign in instead.")
        user_id = uid()
        db.execute("INSERT INTO users(id,email,password_hash,role,name,created_at,google_sub,college_name) VALUES (?,?,?,?,?,?,?,?)",
                   (user_id, email, hash_secret(body.password), "teacher",
                    body.name.strip(), now_iso(), identity["sub"], SAHE_INSTITUTION_NAME))
        db.execute("INSERT INTO teacher_profiles(user_id) VALUES (?)", (user_id,))
        dept_name = str(payload.get("departmentName", "")).strip()
        if dept_name:
            dept_id, join_code = uid(), secrets.token_urlsafe(24)
            db.execute("INSERT INTO departments(id,name,join_code_hash,created_at,hod_user_id) VALUES (?,?,?,?,?)",
                       (dept_id, dept_name, digest_token(join_code), now_iso(), user_id))
            db.execute("UPDATE teacher_profiles SET department_id=? WHERE user_id=?", (dept_id, user_id))
            db.execute("INSERT INTO department_members(department_id,user_id,joined_at,role,manage_timetable,mark_attendance,enroll_students,post_announcements,view_analytics) VALUES (?,?,?,'hod',1,1,1,1,1)",
                       (dept_id, user_id, now_iso()))
        for item in payload.get("assignments", []):
            branch, year = str(item["branch"]).strip().upper(), int(item["year"])
            section = str(item["section"]).strip().upper()
            code, name = str(item["subjectCode"]).strip().upper(), str(item["subjectName"]).strip()
            section_id = f"{branch}-{year}-{section}"
            db.execute("INSERT OR IGNORE INTO sections(id,branch,year,section) VALUES (?,?,?,?)",
                       (section_id, branch, year, section))
            db.execute("INSERT INTO subjects(id,code,name,branch,year) VALUES (?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,branch=excluded.branch,year=excluded.year",
                       (code, code, name, branch, year))
            db.execute("INSERT OR IGNORE INTO teaching_assignments(id,teacher_id,subject_id,section_id) VALUES (?,?,?,?)",
                       (uid(), user_id, code, section_id))
        db.execute("UPDATE activation_invites SET used_at=? WHERE code_hash=?",
                   (now_iso(), digest_token(body.inviteCode)))
        return make_session(db, user_id)


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
    rows = db.execute("""SELECT s.*, (SELECT COUNT(*) FROM student_profiles p WHERE p.section_id=s.id AND p.enrollment_status='approved') strength
      FROM sections s JOIN teaching_assignments a ON a.section_id=s.id WHERE a.teacher_id=?
      UNION SELECT s.*, (SELECT COUNT(*) FROM student_profiles p WHERE p.section_id=s.id AND p.enrollment_status='approved') strength
      FROM sections s JOIN department_members dm ON dm.user_id=? JOIN departments d ON d.id=dm.department_id
      JOIN teacher_profiles tp ON tp.user_id=? AND tp.department_id=d.id
      JOIN teaching_assignments a ON a.section_id=s.id
      JOIN teacher_profiles assigned ON assigned.user_id=a.teacher_id AND assigned.department_id=d.id""", (teacher_id, teacher_id, teacher_id)).fetchall()
    return [section_obj(r) for r in rows]


@app.get("/api/directory/sections")
def directory_sections(user: sqlite3.Row = Depends(get_user)) -> list[dict[str, Any]]:
    with connect() as db:
        if user["role"] == "student":
            rows = db.execute("SELECT s.*, (SELECT COUNT(*) FROM student_profiles p WHERE p.section_id=s.id AND p.enrollment_status='approved') strength FROM sections s JOIN student_profiles p ON p.section_id=s.id WHERE p.user_id=?", (user["id"],)).fetchall()
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


def effective_section_schedule(db: sqlite3.Connection, section_id: str, target: date) -> list[dict[str, Any]]:
    rows = db.execute("""SELECT ts.*,e.kind exception_kind,e.start_time exception_start,
        e.end_time exception_end,e.room exception_room
        FROM timetable_slots ts LEFT JOIN timetable_exceptions e
          ON e.slot_id=ts.id AND e.date=?
        WHERE ts.section_id=? AND ts.day_of_week=?
          AND NOT EXISTS (SELECT 1 FROM timetable_exceptions added
            WHERE added.slot_id=ts.id AND added.kind='add')
        ORDER BY ts.start_time""", (target.isoformat(), section_id, target.isoweekday())).fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        if row["exception_kind"] == "cancel":
            continue
        slot = slot_obj(row)
        if row["exception_kind"] == "modify":
            slot["startTime"] = row["exception_start"] or slot["startTime"]
            slot["endTime"] = row["exception_end"] or slot["endTime"]
            slot["room"] = row["exception_room"] if row["exception_room"] is not None else slot["room"]
            slot["dateChange"] = "modified"
        result.append(slot)

    additions = db.execute("""SELECT ts.* FROM timetable_exceptions e
        JOIN timetable_slots ts ON ts.id=e.slot_id
        WHERE e.date=? AND e.section_id=? AND e.kind='add'
          AND e.cancelled=0
        ORDER BY ts.start_time""", (target.isoformat(), section_id)).fetchall()
    result.extend({**slot_obj(row), "dateChange": "added"} for row in additions)
    return sorted(result, key=lambda slot: (slot["startTime"], slot["endTime"]))


def record_camera_run(
    db: sqlite3.Connection, section_id: str, slot_id: str, target: date,
    camera_id: str, event_type: str, observed_at: datetime,
) -> None:
    if event_type not in ("entry", "exit"):
        raise ValueError("Camera event type must be entry or exit.")
    stamp = observed_at.isoformat(timespec="seconds")
    db.execute("""INSERT INTO camera_runs
        (camera_id,event_type,section_id,slot_id,date,started_at,last_heartbeat_at,heartbeat_count)
        VALUES (?,?,?,?,?,?,?,1)
        ON CONFLICT(camera_id,event_type,slot_id,date) DO UPDATE SET
          last_heartbeat_at=excluded.last_heartbeat_at,heartbeat_count=camera_runs.heartbeat_count+1""",
        (camera_id,event_type,section_id,slot_id,target.isoformat(),stamp,stamp))


def record_camera_attendance_event(
    db: sqlite3.Connection, section_id: str, slot: dict[str, Any], target: date,
    student_id: str, camera_id: str, event_type: str, observed_at: datetime,
    score: float, late_grace_minutes: int = 10, early_exit_review_minutes: int = 5,
) -> bool:
    if event_type not in ("entry", "exit"):
        raise ValueError("Camera event type must be entry or exit.")
    if not 0 <= score <= 1:
        raise ValueError("Face-match score must be between 0 and 1.")
    if slot["sectionId"] != section_id:
        raise ValueError("Camera event slot does not belong to the configured section.")

    day_start = datetime.combine(target, time.fromisoformat(slot["startTime"]))
    day_end = datetime.combine(target, time.fromisoformat(slot["endTime"]))
    event_clock = observed_at.replace(tzinfo=None)
    event_end = day_end + (timedelta(minutes=5) if event_type == "exit" else timedelta())
    if event_clock < day_start or event_clock > event_end:
        return False
    approved = db.execute("""SELECT 1 FROM student_profiles
        WHERE student_id=? AND section_id=? AND enrollment_status='approved'""",
        (student_id,section_id)).fetchone()
    if approved is None:
        return False
    if db.execute("SELECT 1 FROM attendance_sessions WHERE slot_id=? AND date=?",
                  (slot["id"],target.isoformat())).fetchone():
        return False

    stamp = observed_at.isoformat(timespec="seconds")
    inserted = db.execute("""INSERT OR IGNORE INTO camera_attendance_events
        (id,student_id,slot_id,date,event_type,camera_id,observed_at,score)
        VALUES (?,?,?,?,?,?,?,?)""",
        (uid(),student_id,slot["id"],target.isoformat(),event_type,camera_id,stamp,score))
    if inserted.rowcount == 0:
        return False

    clock = observed_at.strftime("%H:%M:%S")
    current = db.execute("""SELECT id,status,in_time,method FROM class_attendance
        WHERE student_id=? AND slot_id=? AND date=?""",
        (student_id,slot["id"],target.isoformat())).fetchone()
    if current is None:
        status = "present"
        in_time = None
        if event_type == "entry":
            late_after = day_start + timedelta(minutes=late_grace_minutes)
            status = "late" if event_clock > late_after else "present"
            in_time = clock
        db.execute("""INSERT INTO class_attendance
            (id,student_id,slot_id,date,status,in_time,out_time,method,marked_by,created_at)
            VALUES (?,?,?,?,?,?,NULL,'face',?,?)""",
            (uid(),student_id,slot["id"],target.isoformat(),status,in_time,slot["teacherId"],stamp))
    elif current["method"] == "face" and event_type == "entry" and (
        current["in_time"] is None or clock < current["in_time"]
    ):
        late_after = day_start + timedelta(minutes=late_grace_minutes)
        status = "late" if event_clock > late_after else "present"
        db.execute("UPDATE class_attendance SET status=?,in_time=? WHERE id=?",
                   (status,clock,current["id"]))

    if event_type == "exit" and event_clock <= day_end - timedelta(minutes=early_exit_review_minutes):
        db.execute("""INSERT INTO camera_attendance_reviews
            (student_id,slot_id,date,reason,flagged_at)
            VALUES (?,?,?,'early_exit',?)
            ON CONFLICT(student_id,slot_id,date) DO UPDATE SET
              reason='early_exit',flagged_at=excluded.flagged_at,
              resolved_at=NULL,resolved_by=NULL""",
            (student_id,slot["id"],target.isoformat(),stamp))
    return True


def ranges_overlap(start_a: str, end_a: str, start_b: str, end_b: str) -> bool:
    return start_a < end_b and end_a > start_b


def validate_timetable_change(
    db: sqlite3.Connection, body: TimetableChangeInput, user: sqlite3.Row
) -> dict[str, Any]:
    try:
        target = date.fromisoformat(body.date)
        if target.isoformat() != body.date:
            raise ValueError
    except ValueError as exc:
        raise HTTPException(422, "Date must use YYYY-MM-DD.") from exc
    if target < date.today():
        raise HTTPException(422, "Timetable changes can only be published for today or a future date.")
    if target.isoweekday() > 6:
        raise HTTPException(422, "Timetable changes are only available Monday through Saturday.")

    if db.execute("SELECT 1 FROM teaching_assignments WHERE teacher_id=? AND section_id=? LIMIT 1",
                  (user["id"], body.sectionId)).fetchone() is None:
        raise HTTPException(403, "You can only change a class you are assigned to teach.")

    if body.kind in ("cancel", "modify"):
        if not body.slotId:
            raise HTTPException(422, "Choose the scheduled period to change.")
        slot = db.execute("SELECT * FROM timetable_slots WHERE id=? AND section_id=? AND day_of_week=?",
                          (body.slotId, body.sectionId, target.isoweekday())).fetchone()
        existing = db.execute("SELECT * FROM timetable_exceptions WHERE date=? AND slot_id=?",
                              (body.date, body.slotId)).fetchone()
        added = existing is not None and existing["kind"] == "add"
        if slot is None or (added and body.kind != "cancel"):
            raise HTTPException(404, "That recurring period is not on the selected date.")
        if db.execute("SELECT 1 FROM teaching_assignments WHERE teacher_id=? AND section_id=? AND subject_id=?",
                      (user["id"], body.sectionId, slot["subject_id"])).fetchone() is None:
            raise HTTPException(403, "You can only change a period for a subject you are assigned to teach.")
        if existing is not None and existing["kind"] == "add" and existing["cancelled"]:
            raise HTTPException(409, "This extra period has already been cancelled.")
        if body.kind == "cancel":
            cancelled_slot = slot_obj(slot)
            if added:
                cancelled_slot["dateChange"] = "added"
            return {"target": target, "slot": cancelled_slot, "startTime": slot["start_time"],
                    "endTime": slot["end_time"], "room": slot["room"], "subjectId": slot["subject_id"],
                    "cancels_added": added}
        start_value = body.startTime or slot["start_time"]
        end_value = body.endTime or slot["end_time"]
        room_value = body.room if body.room is not None else slot["room"]
        if body.startTime is not None or body.endTime is not None:
            try:
                start = time.fromisoformat(start_value)
                end = time.fromisoformat(end_value)
                if start.strftime("%H:%M") != start_value or end.strftime("%H:%M") != end_value or start >= end:
                    raise ValueError
            except ValueError as exc:
                raise HTTPException(422, "Use valid 24-hour HH:MM times, with the end after the start.") from exc
        candidate = {**slot_obj(slot), "startTime": start_value, "endTime": end_value, "room": room_value}
        excluded_slot_id = body.slotId
    else:
        if not body.subjectId:
            raise HTTPException(422, "Choose an assigned subject for the extra period.")
        assignment = db.execute("SELECT 1 FROM teaching_assignments WHERE teacher_id=? AND section_id=? AND subject_id=?",
                                (user["id"], body.sectionId, body.subjectId)).fetchone()
        if assignment is None:
            raise HTTPException(403, "Choose a subject assigned to you for this class.")
        if not body.startTime or not body.endTime:
            raise HTTPException(422, "Enter a start and end time for the extra period.")
        try:
            start = time.fromisoformat(body.startTime)
            end = time.fromisoformat(body.endTime)
            if start.strftime("%H:%M") != body.startTime or end.strftime("%H:%M") != body.endTime or start >= end:
                raise ValueError
        except ValueError as exc:
            raise HTTPException(422, "Use valid 24-hour HH:MM times, with the end after the start.") from exc
        reserved = db.execute("""SELECT 1 FROM timetable_slots
            WHERE section_id=? AND day_of_week=? AND start_time=? LIMIT 1""",
            (body.sectionId, target.isoweekday(), body.startTime)).fetchone()
        if reserved:
            raise HTTPException(409, "That start time is already reserved by a recurring or previously used period. Choose another start time.")
        subject = db.execute("SELECT code FROM subjects WHERE id=?", (body.subjectId,)).fetchone()
        candidate = {
            "id": "", "sectionId": body.sectionId, "subjectId": body.subjectId,
            "teacherId": user["id"], "dayOfWeek": target.isoweekday(),
            "startTime": body.startTime, "endTime": body.endTime, "room": body.room or "",
            "subjectCode": subject["code"] if subject else body.subjectId,
        }
        excluded_slot_id = None

    if body.kind != "cancel":
        for existing in effective_section_schedule(db, body.sectionId, target):
            if existing["id"] != excluded_slot_id and ranges_overlap(
                candidate["startTime"], candidate["endTime"], existing["startTime"], existing["endTime"]
            ):
                raise HTTPException(409, f"This change overlaps another period ({existing['startTime']}–{existing['endTime']}).")
        teacher_slots = db.execute("SELECT DISTINCT section_id FROM teaching_assignments WHERE teacher_id=?",
                                   (user["id"],)).fetchall()
        for section in teacher_slots:
            for existing in effective_section_schedule(db, section["section_id"], target):
                if (existing["id"] != excluded_slot_id and existing["sectionId"] != body.sectionId
                        and ranges_overlap(candidate["startTime"], candidate["endTime"],
                                           existing["startTime"], existing["endTime"])):
                    raise HTTPException(409, f"This change conflicts with your other class ({existing['sectionId']}, {existing['startTime']}–{existing['endTime']}).")
    return {"target": target, "slot": candidate, "startTime": candidate["startTime"],
            "endTime": candidate["endTime"], "room": candidate["room"],
            "subjectId": candidate["subjectId"]}


@app.post("/api/teacher/timetable/changes/preview")
def preview_timetable_change(body: TimetableChangeInput, user: sqlite3.Row = Depends(require_teacher)) -> dict[str, Any]:
    with connect() as db:
        result = validate_timetable_change(db, body, user)
        return {"kind": body.kind, "date": body.date, "slot": result["slot"]}


@app.post("/api/teacher/timetable/changes")
def create_timetable_change(body: TimetableChangeInput, user: sqlite3.Row = Depends(require_teacher)) -> dict[str, Any]:
    with connect() as db:
        validated = validate_timetable_change(db, body, user)
        slot_id = body.slotId
        if body.kind == "add":
            slot_id = uid()
            db.execute("""INSERT INTO timetable_slots(id,section_id,subject_id,teacher_id,day_of_week,start_time,end_time,room)
                VALUES (?,?,?,?,?,?,?,?)""",
                (slot_id, body.sectionId, body.subjectId, user["id"], validated["target"].isoweekday(),
                 validated["startTime"], validated["endTime"], validated["room"]))
        assert slot_id is not None
        if body.kind == "cancel" and validated.get("cancels_added"):
            db.execute("UPDATE timetable_exceptions SET cancelled=1 WHERE date=? AND slot_id=? AND kind='add'",
                       (body.date, slot_id))
        else:
            db.execute("""INSERT INTO timetable_exceptions(id,date,section_id,slot_id,kind,start_time,end_time,room,created_by,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(date,slot_id) DO UPDATE SET kind=excluded.kind,
                  start_time=excluded.start_time,end_time=excluded.end_time,room=excluded.room,
                  cancelled=0,created_by=excluded.created_by,created_at=excluded.created_at""",
                (uid(), body.date, body.sectionId, slot_id, body.kind,
                 validated["startTime"] if body.kind == "modify" else None,
                 validated["endTime"] if body.kind == "modify" else None,
                 validated["room"] if body.kind == "modify" else None, user["id"], now_iso()))
        return {"message": "Date-specific timetable change published."}


def record_obj(row: sqlite3.Row, section_id: str, subject_id: str = "", slot_id: str = "") -> dict[str, Any]:
    return {"id": row["id"], "studentId": row["student_id"], "subjectId": subject_id, "slotId": slot_id,
      "sectionId": section_id, "date": row["date"], "status": row["status"], "inTime": row["in_time"],
      "outTime": row["out_time"], "method": row["method"], "markedBy": row["marked_by"]}


def attendance_review(db: sqlite3.Connection, student_id: str, target: str,
                      slot_id: str | None = None) -> dict[str, Any]:
    query = """SELECT reason FROM camera_attendance_reviews
        WHERE student_id=? AND date=? AND resolved_at IS NULL"""
    values: tuple[Any, ...] = (student_id,target)
    if slot_id:
        query += " AND slot_id=?"
        values += (slot_id,)
    query += " ORDER BY flagged_at LIMIT 1"
    review = db.execute(query,values).fetchone()
    return {"reviewRequired": review is not None,
            "reviewReason": review["reason"] if review else None}


@app.get("/api/student/attendance")
def student_attendance(from_: str = __import__("fastapi").Query(default="", alias="from"), to: str = "", user: sqlite3.Row = Depends(get_user)) -> list[dict[str, Any]]:
    if user["role"] != "student":
        raise HTTPException(403, "Student access is required.")
    with connect() as db:
        p = student_profile(db, user)
        require_approved_student(db, user)
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
        q2 = """SELECT ca.*,ts.subject_id,ts.id slot_id FROM class_attendance ca
          JOIN timetable_slots ts ON ts.id=ca.slot_id
          JOIN attendance_sessions ses ON ses.slot_id=ca.slot_id AND ses.date=ca.date
          WHERE ca.student_id=?"""
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
        require_approved_student(db, user)
        rows = db.execute("""SELECT s.id subject_id,s.code subject_code,s.name subject_name,
          COUNT(*) held_count,SUM(ca.status='present') present_count,SUM(ca.status='absent') absent_count,
          SUM(ca.status='late') late_count,SUM(ca.status='excused') excused_count
          FROM class_attendance ca JOIN timetable_slots ts ON ts.id=ca.slot_id JOIN subjects s ON s.id=ts.subject_id
          JOIN attendance_sessions ses ON ses.slot_id=ca.slot_id AND ses.date=ca.date
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
        require_approved_student(db, user)
        result = []
        for slot in effective_section_schedule(db, p["sectionId"], target):
            subject = db.execute("SELECT * FROM subjects WHERE id=?", (slot["subjectId"],)).fetchone()
            teacher = db.execute("SELECT name FROM users WHERE id=?", (slot["teacherId"],)).fetchone()
            row = db.execute("SELECT * FROM class_attendance WHERE student_id=? AND slot_id=? AND date=?",
                             (p["studentId"], slot["id"], target.isoformat())).fetchone()
            rec = record_obj(row, p["sectionId"], slot["subjectId"], slot["id"]) if row else None
            result.append({
                "slot": slot,
                "subject": {
                    "id": slot["subjectId"], "code": subject["code"] if subject else slot["subjectId"],
                    "name": subject["name"] if subject else slot["subjectId"],
                    "branch": subject["branch"] if subject else "",
                    "year": subject["year"] if subject else 0,
                },
                "teacherName": teacher["name"] if teacher else "",
                "record": rec, "status": row["status"] if row else "unmarked",
            })
        return result


@app.get("/api/teacher/assignments")
def teacher_assignments(user: sqlite3.Row = Depends(require_teacher)) -> list[dict[str, Any]]:
    with connect() as db: return sections_for_teacher(db,user["id"])


@app.get("/api/timetable")
def timetable(sectionId: str, date_: str = __import__("fastapi").Query(default="", alias="date"),
              user: sqlite3.Row = Depends(get_user)) -> list[dict[str, Any]]:
    with connect() as db:
        if user["role"] == "student":
            require_approved_student(db,user)
            if student_profile(db,user)["sectionId"] != sectionId: raise HTTPException(403,"You cannot view this class timetable.")
        else:
            require_assignment(db,user["id"],sectionId)
        if date_:
            try:
                target = date.fromisoformat(date_)
                if target.isoformat() != date_:
                    raise ValueError
            except ValueError as exc:
                raise HTTPException(422, "Date must use YYYY-MM-DD.") from exc
            return effective_section_schedule(db, sectionId, target)
        return [slot_obj(r) for r in db.execute("""SELECT ts.* FROM timetable_slots ts
          WHERE ts.section_id=? AND NOT EXISTS (SELECT 1 FROM timetable_exceptions e
            WHERE e.slot_id=ts.id AND e.kind='add')
          ORDER BY ts.day_of_week,ts.start_time""",(sectionId,)).fetchall()]


@app.get("/api/teacher/schedule")
def teacher_schedule(date_: str = __import__("fastapi").Query(default="", alias="date"), user: sqlite3.Row = Depends(require_teacher)) -> list[dict[str, Any]]:
    try:
        target = date.fromisoformat(date_) if date_ else date.today()
        if date_ and target.isoformat() != date_:
            raise ValueError
    except ValueError as exc: raise HTTPException(422,"Date must use YYYY-MM-DD.") from exc
    with connect() as db:
        sections = sections_for_teacher(db, user["id"])
        slots = [slot for section in sections for slot in effective_section_schedule(db, section["id"], target)]
        profile = db.execute("SELECT department_id FROM teacher_profiles WHERE user_id=?", (user["id"],)).fetchone()
        hod = profile is not None and profile["department_id"] is not None and db.execute(
            "SELECT 1 FROM departments WHERE id=? AND hod_user_id=?",
            (profile["department_id"], user["id"]),
        ).fetchone() is not None
        visible = slots if hod else [slot for slot in slots if slot["teacherId"] == user["id"]]
        return sorted(visible,
                      key=lambda slot: (slot["startTime"], slot["endTime"]))


@app.get("/api/teacher/roster")
def teacher_roster(sectionId: str, date_: str = __import__("fastapi").Query(alias="date"), slotId: str | None = None, user: sqlite3.Row = Depends(require_teacher)) -> list[dict[str, Any]]:
    try:
        target=date.fromisoformat(date_)
        if target.isoformat() != date_:
            raise ValueError
    except ValueError as exc: raise HTTPException(422,"Date must use YYYY-MM-DD.") from exc
    with connect() as db:
        if slotId and db.execute("""SELECT 1 FROM timetable_exceptions
          WHERE date=? AND slot_id=? AND (kind='cancel' OR (kind='add' AND cancelled=1))""",
                                 (target.isoformat(), slotId)).fetchone():
            raise HTTPException(409, "This period was cancelled for that date.")
        require_assignment(db,user["id"],sectionId)
        if slotId and not any(slot["id"] == slotId for slot in effective_section_schedule(db, sectionId, target)):
            raise HTTPException(404, "Period is not scheduled for that class and date.")
        if slotId and db.execute("SELECT 1 FROM timetable_slots WHERE id=? AND section_id=?",(slotId,sectionId)).fetchone() is None: raise HTTPException(404,"Period not found.")
        students=db.execute("""SELECT s.student_id,s.name,p.enrollment_status FROM student_profiles p JOIN students s ON s.student_id=p.student_id
          WHERE p.section_id=? ORDER BY s.name""",(sectionId,)).fetchall()
        result=[]
        for student in students:
            q="SELECT * FROM class_attendance WHERE student_id=? AND date=?"; args: list[Any]=[student["student_id"],target.isoformat()]
            if slotId: q+=" AND slot_id=?";args.append(slotId)
            rows=db.execute(q+" ORDER BY in_time",args).fetchall()
            if not rows:
                review=attendance_review(db,student["student_id"],target.isoformat(),slotId)
                result.append({"studentId":student["student_id"],"name":student["name"],"status":"unmarked","inTime":None,"method":None,"enrollmentStatus":student["enrollment_status"],**review})
            else:
                for row in rows:
                    review=attendance_review(db,student["student_id"],target.isoformat(),row["slot_id"])
                    result.append({"studentId":student["student_id"],"name":student["name"],"status":row["status"],"inTime":row["in_time"],"method":row["method"],"enrollmentStatus":student["enrollment_status"],**review})
        return result


@app.get("/api/teacher/attendance/session")
def attendance_session(sectionId: str, date_: str = __import__("fastapi").Query(alias="date"),
                       slotId: str = "", user: sqlite3.Row = Depends(require_teacher)) -> dict[str, Any]:
    try:
        target = date.fromisoformat(date_)
        if target.isoformat() != date_:
            raise ValueError
    except ValueError as exc:
        raise HTTPException(422, "Date must use YYYY-MM-DD.") from exc
    if not slotId:
        raise HTTPException(422, "Choose a scheduled period.")
    with connect() as db:
        require_assignment(db, user["id"], sectionId)
        scheduled = next((slot for slot in effective_section_schedule(db, sectionId, target)
                          if slot["id"] == slotId), None)
        if scheduled is None:
            raise HTTPException(404, "Period not found for that teacher and date.")
        session = db.execute(
            "SELECT completed_at FROM attendance_sessions WHERE section_id=? AND slot_id=? AND date=?",
            (sectionId, slotId, date_.strip()),
        ).fetchone()
        camera_session = db.execute(
            "SELECT 1 FROM camera_runs WHERE section_id=? AND slot_id=? AND date=? LIMIT 1",
            (sectionId,slotId,date_.strip()),
        ).fetchone() is not None
        return {"completed": session is not None, "completedAt": session["completed_at"] if session else None,
                "cameraSession": camera_session}


class StudentReviewInput(BaseModel):
    sectionId: str
    status: str = Field(pattern="^(approved|rejected)$")


@app.patch("/api/teacher/students/{student_id}/enrollment")
def review_student(student_id: str, body: StudentReviewInput, user: sqlite3.Row = Depends(require_teacher)) -> dict[str, str]:
    with connect() as db:
        require_assignment(db, user["id"], body.sectionId)
        cursor = db.execute("UPDATE student_profiles SET enrollment_status=? WHERE student_id=? AND section_id=?",
                            (body.status, student_id, body.sectionId))
        if cursor.rowcount == 0:
            raise HTTPException(404, "Student class request was not found.")
        return {"studentId": student_id, "enrollmentStatus": body.status}


@app.patch("/api/teacher/attendance")
def mark_attendance(body: MarkInput, user: sqlite3.Row = Depends(require_teacher)) -> dict[str, Any]:
    try:
        target = date.fromisoformat(body.date)
        if target.isoformat() != body.date:
            raise ValueError
    except ValueError as exc:
        raise HTTPException(422,"Date must use YYYY-MM-DD.") from exc
    if target > date.today():
        raise HTTPException(422, "Attendance cannot be marked for a future date.")
    with connect() as db:
        exception = db.execute("SELECT kind,cancelled FROM timetable_exceptions WHERE date=? AND slot_id=? AND section_id=?",
                               (body.date, body.slotId, body.sectionId)).fetchone()
        if exception and (exception["kind"] == "cancel" or
                          (exception["kind"] == "add" and exception["cancelled"])):
            raise HTTPException(409, "This period was cancelled for that date.")
        require_assignment(db,user["id"],body.sectionId,body.slotId)
        slot=db.execute("SELECT * FROM timetable_slots WHERE id=? AND section_id=?",(body.slotId,body.sectionId)).fetchone()
        if slot is None: raise HTTPException(404,"Period not found.")
        scheduled = next((item for item in effective_section_schedule(db, body.sectionId, target)
                          if item["id"] == body.slotId and item["teacherId"] == user["id"]), None)
        if scheduled is None:
            raise HTTPException(404, "Period is not scheduled for you on that date.")
        student=db.execute("SELECT enrollment_status FROM student_profiles WHERE student_id=? AND section_id=?",(body.studentId,body.sectionId)).fetchone()
        if student is None: raise HTTPException(404,"Student is not in this class.")
        if student["enrollment_status"]!="approved": raise HTTPException(409,"Approve the student's class membership before marking attendance.")
        existing=db.execute("SELECT * FROM class_attendance WHERE student_id=? AND slot_id=? AND date=?",(body.studentId,body.slotId,body.date)).fetchone()
        row_id=existing["id"] if existing else uid()
        stamp=datetime.now().strftime("%H:%M:%S") if body.status in ("present","late") else None
        db.execute("""INSERT INTO class_attendance(id,student_id,slot_id,date,status,in_time,out_time,method,marked_by,created_at)
          VALUES (?,?,?,?,?,?,NULL,'manual',?,?) ON CONFLICT(student_id,slot_id,date) DO UPDATE SET
          status=excluded.status,in_time=excluded.in_time,method='manual',marked_by=excluded.marked_by""",
          (row_id,body.studentId,body.slotId,body.date,body.status,stamp,user["id"],now_iso()))
        db.execute("""UPDATE camera_attendance_reviews SET resolved_at=?,resolved_by=?
          WHERE student_id=? AND slot_id=? AND date=? AND resolved_at IS NULL""",
          (now_iso(),user["id"],body.studentId,body.slotId,body.date))
        row=db.execute("SELECT * FROM class_attendance WHERE id=?",(row_id,)).fetchone()
        return record_obj(row,body.sectionId,slot["subject_id"],slot["id"])


@app.post("/api/teacher/attendance/complete")
def complete_attendance(body: CompleteAttendanceInput, user: sqlite3.Row = Depends(require_teacher)) -> dict[str, Any]:
    try:
        target = date.fromisoformat(body.date)
        if target.isoformat() != body.date:
            raise ValueError
    except ValueError as exc:
        raise HTTPException(422, "Date must use YYYY-MM-DD.") from exc
    if target > date.today():
        raise HTTPException(422, "A future period cannot be completed.")
    with connect() as db:
        require_assignment(db, user["id"], body.sectionId, body.slotId)
        scheduled = next((item for item in effective_section_schedule(db, body.sectionId, target)
                          if item["id"] == body.slotId and item["teacherId"] == user["id"]), None)
        if scheduled is None:
            raise HTTPException(404, "Period is not scheduled for you on that date.")
        existing = db.execute(
            "SELECT completed_at FROM attendance_sessions WHERE section_id=? AND slot_id=? AND date=?",
            (body.sectionId, body.slotId, body.date),
        ).fetchone()
        if existing:
            return {"completed": True, "completedAt": existing["completed_at"], "absencesAdded": 0, "reviewRequired": 0}
        if target == date.today() and scheduled["endTime"] > datetime.now().strftime("%H:%M"):
            raise HTTPException(409, "This period has not ended yet.")

        camera_session = db.execute(
            "SELECT 1 FROM camera_runs WHERE section_id=? AND slot_id=? AND date=? LIMIT 1",
            (body.sectionId,body.slotId,body.date),
        ).fetchone() is not None
        approved_students = db.execute(
            "SELECT student_id FROM student_profiles WHERE section_id=? AND enrollment_status='approved'",
            (body.sectionId,),
        ).fetchall()
        if camera_session:
            for student in approved_students:
                mark = db.execute("""SELECT 1 FROM class_attendance
                    WHERE student_id=? AND slot_id=? AND date=?""",
                    (student["student_id"],body.slotId,body.date)).fetchone()
                if mark is None:
                    db.execute("""INSERT OR IGNORE INTO camera_attendance_reviews
                        (student_id,slot_id,date,reason,flagged_at)
                        VALUES (?,?,?,'not_observed',?)""",
                        (student["student_id"],body.slotId,body.date,now_iso()))
            review_required = db.execute("""SELECT COUNT(*) FROM camera_attendance_reviews
                WHERE slot_id=? AND date=? AND resolved_at IS NULL""",
                (body.slotId,body.date)).fetchone()[0]
            if review_required:
                return {"completed": False, "completedAt": None, "absencesAdded": 0,
                        "reviewRequired": review_required}

        completed_at = now_iso()
        db.execute(
            "INSERT INTO attendance_sessions(id,section_id,slot_id,date,completed_by,completed_at) VALUES (?,?,?,?,?,?)",
            (uid(), body.sectionId, body.slotId, body.date, user["id"], completed_at),
        )
        absences_added = 0
        if not camera_session:
            for student in approved_students:
                cursor = db.execute("""INSERT OR IGNORE INTO class_attendance
                    (id,student_id,slot_id,date,status,in_time,out_time,method,marked_by,created_at)
                    VALUES (?,?,?,?,'absent',NULL,NULL,'manual',?,?)""",
                    (uid(), student["student_id"], body.slotId, body.date, user["id"], completed_at))
                absences_added += cursor.rowcount
        return {"completed": True, "completedAt": completed_at, "absencesAdded": absences_added,
                "reviewRequired": 0}


def parse_timetable(csv_text: str) -> tuple[list[dict[str, Any]], list[str]]:
    required={"day","start","end","subject_code","subject_name","section"}
    try: reader=csv.DictReader(io.StringIO(csv_text))
    except csv.Error as exc: return [],[str(exc)]
    if reader.fieldnames:
        # Excel's UTF-8 CSV export commonly prefixes the first header with a BOM.
        aliases = {
            "weekday": "day", "week_day": "day",
            "start_time": "start", "from": "start",
            "end_time": "end", "to": "end",
            "code": "subject_code", "course_code": "subject_code",
            "subject": "subject_name", "course_name": "subject_name",
            "class": "section", "section_id": "section",
            "room_no": "room", "room_number": "room", "classroom": "room",
            "instructor_email": "teacher_email", "email": "teacher_email",
        }
        normalized = []
        for heading in reader.fieldnames:
            key = re.sub(r"[^a-z0-9]+", "_", heading.lstrip("\ufeff").strip().lower()).strip("_")
            normalized.append(aliases.get(key, key))
        reader.fieldnames = normalized
    if not reader.fieldnames or not required.issubset(set(reader.fieldnames)):
        return [],["CSV needs columns for day, start time, end time, subject code, subject name, and section. Room and teacher_email are optional."]
    rows=[]; errors=[]; seen=set()
    day_map={"mon":1,"monday":1,"tue":2,"tuesday":2,"wed":3,"wednesday":3,"thu":4,"thursday":4,"fri":5,"friday":5,"sat":6,"saturday":6}
    for line, raw in enumerate(reader,2):
        row={str(k).strip().lower():str(v or "").strip() for k,v in raw.items() if k is not None}
        try:
            day=day_map.get(row.get("day"," ").lower())
            def parse_hhmm(value: str) -> time:
                parts = value.strip().split(":")
                if len(parts) != 2 or not all(part.isdigit() for part in parts):
                    raise ValueError("time must use H:MM or HH:MM 24-hour format")
                return time(int(parts[0]), int(parts[1]))
            start=parse_hhmm(row["start"]); end=parse_hhmm(row["end"])
            code=row["subject_code"].upper(); name=row["subject_name"]
            if day is None: raise ValueError("day must be Mon-Sat")
            if start >= end: raise ValueError("end must be later than start")
            if not code or not name or not row["section"]: raise ValueError("subject code, subject name, and section are required")
            key=(day,start.strftime("%H:%M"))
            if key in seen: raise ValueError("duplicate day and start time")
            seen.add(key)
            rows.append({"line":line,"day":day,"start":start.strftime("%H:%M"),"end":end.strftime("%H:%M"),"code":code,"name":name,"section":row["section"].upper(),"room":row.get("room", ""),"email":row.get("teacher_email", "").lower()})
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
        if subject is None or assignment is None:
            errors.append(f"Line {row['line']}: subject {row['code']} is not assigned to your account for {body.sectionId}. Ask the SAHE timetable administrator to add this subject to your teaching assignment.")
            continue
        valid.append(row)
    # Validate overlaps before saving; reject conflicting rows, preserve existing grid.
    for index, row in enumerate(valid):
        one_off = db.execute("""SELECT e.date FROM timetable_slots ts
          JOIN timetable_exceptions e ON e.slot_id=ts.id AND e.kind='add' AND e.cancelled=0
          WHERE ts.section_id=? AND ts.day_of_week=? AND ts.start_time=? LIMIT 1""",
          (body.sectionId,row["day"],row["start"])).fetchone()
        if one_off:
            errors.append(f"Line {row['line']}: period conflicts with a one-time extra class on {one_off['date']}.")
            row["rejected"] = True
            continue
        retained_one_off = db.execute("""SELECT e.date FROM timetable_slots ts
          JOIN timetable_exceptions e ON e.slot_id=ts.id AND e.kind='add' AND e.cancelled=1
          WHERE ts.section_id=? AND ts.day_of_week=? AND ts.start_time=? LIMIT 1""",
          (body.sectionId,row["day"],row["start"])).fetchone()
        if retained_one_off:
            errors.append(f"Line {row['line']}: start time is retained for attendance history from a cancelled one-time period on {retained_one_off['date']}; choose another start time.")
            row["rejected"] = True
            continue
        overlap=db.execute("""SELECT 1 FROM timetable_slots WHERE section_id=? AND day_of_week=?
          AND start_time < ? AND end_time > ? AND start_time<>?
          AND NOT EXISTS (SELECT 1 FROM timetable_exceptions e WHERE e.slot_id=timetable_slots.id AND e.kind='add')""",
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
    imported=sum(db.execute("""SELECT 1 FROM timetable_slots ts WHERE ts.section_id=? AND ts.day_of_week=? AND ts.start_time=?
      AND NOT EXISTS (SELECT 1 FROM timetable_exceptions e WHERE e.slot_id=ts.id AND e.kind='add')""",
      (body.sectionId,r["day"],r["start"])).fetchone() is None for r in valid)
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
          COUNT(DISTINCT ses.id) sessions,COUNT(ca.id) marked,
          SUM(ca.status IN ('present','late')) present,SUM(ca.status='excused') excused
          FROM attendance_sessions ses
          JOIN class_attendance ca ON ca.slot_id=ses.slot_id AND ca.date=ses.date
          JOIN timetable_slots ts ON ts.id=ses.slot_id JOIN subjects su ON su.id=ts.subject_id
          JOIN student_profiles sp ON sp.student_id=ca.student_id AND sp.enrollment_status='approved'
          WHERE EXISTS (SELECT 1 FROM teaching_assignments a
            JOIN teacher_profiles tp ON tp.user_id=a.teacher_id
            WHERE a.section_id=ts.section_id AND tp.department_id=?)
          GROUP BY ts.section_id,su.id""",(dept["id"],)).fetchall()
        result=[]
        for r in rows:
            strength=db.execute("SELECT COUNT(*) FROM student_profiles WHERE section_id=? AND enrollment_status='approved'",(r["section_id"],)).fetchone()[0]
            at_risk=None
            if r["sessions"]:
                per_student=db.execute("""SELECT ca.student_id,COUNT(*) held,
                  SUM(status IN ('present','late')) attended,SUM(status='excused') excused
                  FROM class_attendance ca JOIN attendance_sessions ses
                    ON ses.slot_id=ca.slot_id AND ses.date=ca.date
                  JOIN timetable_slots ts ON ts.id=ca.slot_id
                  JOIN student_profiles sp ON sp.student_id=ca.student_id AND sp.enrollment_status='approved'
                  WHERE ts.section_id=? AND ts.subject_id=? AND EXISTS (
                    SELECT 1 FROM teaching_assignments a JOIN teacher_profiles tp ON tp.user_id=a.teacher_id
                    WHERE a.section_id=ts.section_id AND tp.department_id=?)
                  GROUP BY ca.student_id""",(r["section_id"],r["subject_id"],dept["id"])).fetchall()
                at_risk=sum(1 for student in per_student if student["held"]>student["excused"] and
                  student["attended"]/(student["held"]-student["excused"]) < ATTENDANCE_THRESHOLD/100)
            result.append({"sectionId":r["section_id"],"subjectCode":r["code"],"subjectName":r["name"],
              "sessionsHeld":r["sessions"],"presentRate":round(100*r["present"]/(r["marked"]-r["excused"]),1) if r["marked"]>r["excused"] else None,
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
        existing=db.execute("SELECT embedding FROM students WHERE student_id=?",(profile["studentId"],)).fetchone()
        if existing is None: raise HTTPException(404,"No attendance identity is registered for this account.")
        if existing["embedding"]:
            stored=np.frombuffer(existing["embedding"],dtype=np.float32)
            captured=np.frombuffer(embedding,dtype=np.float32)
            if stored.shape != captured.shape or not np.isfinite(stored).all():
                raise HTTPException(409,"That roll number already has an incompatible face record. Contact your attendance operator.")
            if float(np.dot(stored,captured)) < 0.363:
                raise HTTPException(409,"The captured face does not match the face already registered to that roll number.")
            return {"harvestedReferences":0}
        db.execute("UPDATE students SET embedding=? WHERE student_id=?",(embedding,profile["studentId"]))
        db.execute("DELETE FROM student_embeddings WHERE student_id=?",(profile["studentId"],))
        return {"harvestedReferences":0}


@app.exception_handler(sqlite3.IntegrityError)
async def integrity_error(_request, exc: sqlite3.IntegrityError):
    return __import__("fastapi").responses.JSONResponse(status_code=409,content={"detail":"The requested change conflicts with existing data."})
