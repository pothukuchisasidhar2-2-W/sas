"""Create local-only True Eye demo accounts for class review testing."""
from __future__ import annotations

from getpass import getpass
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from api.main import connect, hash_secret, init_db, now_iso  # noqa: E402

STUDENT_EMAIL = "demo.student@trueeye.local"
TEACHER_EMAIL = "demo.teacher@trueeye.local"
STUDENT_ID = "TRUEEYE-DEMO-01"
SECTION = {"id": "CSE-AIDS-2-A", "branch": "CSE-AIDS", "year": 2, "section": "A"}


def main() -> None:
    student_password = getpass("Demo student password (8+ chars): ")
    teacher_password = getpass("Demo teacher password (8+ chars): ")
    if len(student_password) < 8 or len(teacher_password) < 8:
        raise SystemExit("Both passwords must have at least 8 characters.")

    init_db()
    with connect() as db:
        db.execute("INSERT OR IGNORE INTO sections(id,branch,year,section) VALUES (?,?,?,?)",
                   (SECTION["id"], SECTION["branch"], SECTION["year"], SECTION["section"]))
        db.execute("INSERT OR IGNORE INTO students(student_id,name,embedding) VALUES (?,?,?)",
                   (STUDENT_ID, "Demo Student", b""))

        for user_id, email, name, role, password in (
            ("true-eye-demo-student", STUDENT_EMAIL, "Demo Student", "student", student_password),
            ("true-eye-demo-teacher", TEACHER_EMAIL, "Demo Teacher", "teacher", teacher_password),
        ):
            existing = db.execute("SELECT id,role FROM users WHERE email=? COLLATE NOCASE", (email,)).fetchone()
            if existing and existing["role"] != role:
                raise SystemExit(f"{email} is already used by a non-demo account.")
            actual_id = existing["id"] if existing else user_id
            if existing:
                db.execute("UPDATE users SET password_hash=?,active=1 WHERE id=?",
                           (hash_secret(password), actual_id))
            else:
                db.execute("INSERT INTO users(id,email,password_hash,role,name,created_at) VALUES (?,?,?,?,?,?)",
                           (actual_id, email, hash_secret(password), role, name, now_iso()))

        student_user = db.execute("SELECT id FROM users WHERE email=? COLLATE NOCASE", (STUDENT_EMAIL,)).fetchone()["id"]
        teacher_user = db.execute("SELECT id FROM users WHERE email=? COLLATE NOCASE", (TEACHER_EMAIL,)).fetchone()["id"]
        linked = db.execute("SELECT user_id FROM student_profiles WHERE student_id=?", (STUDENT_ID,)).fetchone()
        if linked and linked["user_id"] != student_user:
            raise SystemExit("The demo roll number is linked to a different student account.")
        identity = db.execute("SELECT length(embedding) size FROM students WHERE student_id=?", (STUDENT_ID,)).fetchone()
        if identity and identity["size"] and not linked:
            raise SystemExit("The demo roll number already has a face record; refusing to reuse it.")
        db.execute("INSERT OR IGNORE INTO student_profiles(user_id,student_id,section_id,joined_at,enrollment_status) VALUES (?,?,?,?, 'pending')",
                   (student_user, STUDENT_ID, SECTION["id"], now_iso()))
        db.execute("INSERT OR IGNORE INTO teacher_profiles(user_id) VALUES (?)", (teacher_user,))
        db.execute("INSERT OR IGNORE INTO subjects(id,code,name,branch,year) VALUES ('DEMO101','DEMO101','Demo Class','CSE-AIDS',2)")
        db.execute("INSERT OR IGNORE INTO teaching_assignments(id,teacher_id,subject_id,section_id) VALUES ('true-eye-demo-assignment',?,'DEMO101',?)",
                   (teacher_user, SECTION["id"]))

    print("\nDemo accounts are ready for local testing:")
    print(f"Student: {STUDENT_EMAIL} / (student password entered above) — roll {STUDENT_ID}")
    print(f"Teacher: {TEACHER_EMAIL} / (teacher password entered above)")
    print(f"Class: {SECTION['id']}")
    print("The demo student starts pending. Sign in as the demo teacher, open Teacher > Attendance monitoring, and approve the request.")
    print("The student can then sign in, capture a face, and use the approved class account.")


if __name__ == "__main__":
    main()
