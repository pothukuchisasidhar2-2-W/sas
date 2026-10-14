import json
import sqlite3
import tempfile
import uuid
from datetime import datetime, time, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api import main
from scripts.core.liv_recog import parse_source


@pytest.fixture
def client(monkeypatch):
    with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp_dir:
        monkeypatch.setattr(main, "DB_PATH", Path(temp_dir) / "attendance.db")
        main.init_db()
        with main.connect() as db:
            db.execute("INSERT INTO students(student_id,name,embedding) VALUES ('S100','Test Student',?)", (b"embedding",))
            db.execute("INSERT INTO students(student_id,name,embedding) VALUES ('S200','Other Student',?)", (b"embedding",))
            db.execute("INSERT INTO attendance(student_id,date,in_time,out_time) VALUES ('S100','2026-10-12','09:01:00',NULL)")
            db.execute("INSERT INTO attendance(student_id,date,in_time,out_time) VALUES ('S200','2026-10-12','09:02:00',NULL)")
        with TestClient(main.app) as test_client:
            yield test_client


def invite(role, payload):
    code = "test-invite-" + role + "-" + uuid.uuid4().hex
    with main.connect() as db:
        db.execute("INSERT INTO activation_invites(code_hash,role,payload,expires_at,created_at) VALUES (?,?,?,?,?)",
                   (main.digest_token(code), role, json.dumps(payload), "2099-01-01T00:00:00+00:00", main.now_iso()))
    return code


def signup_with_verified_email(client, path, payload):
    code = "123456"
    with main.connect() as db:
        db.execute(
            "INSERT INTO email_codes(email,purpose,code_hash,expires_at,created_at) VALUES (?,?,?,?,?)",
            (payload["email"], "signup", main.digest_token(code), "2099-01-01T00:00:00+00:00", main.now_iso()),
        )
    return client.post(path, json={**payload, "emailCode": code})


def test_student_self_signup_face_row_and_teacher_approval(client):
    response = signup_with_verified_email(client, "/api/auth/signup/student", {
        "name":"Test Student", "email":"student@gmail.com", "password":"long-password-123",
        "branch":"CSE", "year":2, "section":"A", "studentId":"S100",
    })
    assert response.status_code == 200
    token = response.json()["token"]
    assert response.json()["user"]["profile"]["studentId"] == "S100"
    assert response.json()["user"]["profile"]["enrollmentStatus"] == "pending"
    assert "embedding" not in response.text
    headers = {"Authorization":f"Bearer {token}"}

    attendance = client.get("/api/student/attendance?from=2026-10-01&to=2026-10-31", headers=headers)
    assert attendance.status_code == 403

    teacher_code = invite("teacher", {"assignments":[{
        "subjectCode":"CS201", "subjectName":"Systems", "branch":"CSE", "year":2, "section":"A"}]})
    teacher = signup_with_verified_email(client, "/api/auth/signup/teacher", {
        "name":"Test Teacher", "email":"reviewer@gmail.com", "password":"long-password-123",
        "inviteCode":teacher_code,
    })
    teacher_headers = {"Authorization":f"Bearer {teacher.json()['token']}"}
    roster = client.get("/api/teacher/roster?sectionId=CSE-2-A&date=2026-10-12", headers=teacher_headers)
    assert next(row for row in roster.json() if row["studentId"] == "S100")["enrollmentStatus"] == "pending"

    reject = client.patch("/api/teacher/students/S100/enrollment", headers=teacher_headers,
        json={"sectionId":"CSE-2-A", "status":"rejected"})
    assert reject.status_code == 200
    assert client.get("/api/student/attendance?from=2026-10-01&to=2026-10-31", headers=headers).status_code == 403
    approve = client.patch("/api/teacher/students/S100/enrollment", headers=teacher_headers,
        json={"sectionId":"CSE-2-A", "status":"approved"})
    assert approve.status_code == 200
    assert client.get("/api/auth/me", headers=headers).json()["profile"]["enrollmentStatus"] == "approved"
    attendance = client.get("/api/student/attendance?from=2026-10-01&to=2026-10-31", headers=headers)
    assert attendance.status_code == 200
    assert [row["studentId"] for row in attendance.json()] == ["S100"]
    assert attendance.json()[0]["subjectId"] == ""
    removed = client.patch("/api/teacher/students/S100/enrollment", headers=teacher_headers,
        json={"sectionId":"CSE-2-A", "status":"rejected"})
    assert removed.status_code == 200
    assert client.get("/api/student/attendance?from=2026-10-01&to=2026-10-31", headers=headers).status_code == 403

    forbidden = client.get("/api/teacher/assignments", headers=headers)
    assert forbidden.status_code == 403
    duplicate = signup_with_verified_email(client, "/api/auth/signup/student", {
        "name":"Another", "email":"another@gmail.com", "password":"long-password-123",
        "branch":"CSE", "year":2, "section":"A", "studentId":"S100",
    })
    assert duplicate.status_code == 409


def test_student_signup_creates_new_face_identity_and_class_from_form(client):
    response = signup_with_verified_email(client, "/api/auth/signup/student", {
        "name":"New Student", "email":"newstudent@gmail.com", "password":"long-password-123",
        "branch":"ece", "year":1, "section":"b", "studentId":"S300",
    })
    assert response.status_code == 200
    assert response.json()["user"]["profile"]["sectionId"] == "ECE-1-B"
    assert response.json()["user"]["profile"]["faceEnrolled"] is False
    with main.connect() as db:
        row = db.execute("SELECT name,embedding FROM students WHERE student_id='S300'").fetchone()
    assert row["name"] == "New Student"
    assert row["embedding"] == b""


def test_existing_profiles_migrate_as_approved(monkeypatch):
    with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp_dir:
        db_path = Path(temp_dir) / "legacy.db"
        monkeypatch.setattr(main, "DB_PATH", db_path)
        connection = sqlite3.connect(db_path)
        with connection as db:
            db.execute("CREATE TABLE student_profiles(user_id TEXT PRIMARY KEY, student_id TEXT, section_id TEXT, joined_at TEXT)")
            db.execute("INSERT INTO student_profiles VALUES ('u1','S1','CSE-1-A','2025-01-01T00:00:00+00:00')")
        connection.close()

        main.init_db()
        with main.connect() as db:
            row = db.execute("SELECT enrollment_status FROM student_profiles WHERE user_id='u1'").fetchone()
        assert row["enrollment_status"] == "approved"


def test_teacher_scope_and_timetable_import_validation(client):
    code = invite("teacher", {"departmentName":"Computing", "assignments":[{
        "subjectCode":"CS201", "subjectName":"Systems", "branch":"CSE", "year":2, "section":"A"}]})
    signup = signup_with_verified_email(client, "/api/auth/signup/teacher", {
        "name":"Test Teacher", "email":"teacher@gmail.com", "password":"long-password-123",
        "departmentName":"", "assignments":[{"subjectCode":"EVIL","subjectName":"Unapproved","branch":"CSE","year":2,"section":"A"}],
        "inviteCode":code,
    })
    assert signup.status_code == 200
    token = signup.json()["token"]
    headers = {"Authorization":f"Bearer {token}"}
    profile = signup.json()["user"]["profile"]
    assert [a["subjectCode"] for a in profile["assignments"]] == ["CS201"]

    invalid_scope = client.get("/api/timetable?sectionId=CSE-3-B", headers=headers)
    assert invalid_scope.status_code == 403

    csv = "day,start,end,subject_code,subject_name,section,room,teacher_email\n" \
          "Mon,09:00,09:50,CS201,Systems,A,R1,teacher@gmail.com\n" \
          "Mon,09:30,10:00,CS201,Systems,A,R1,teacher@gmail.com\n"
    preview = client.post("/api/teacher/timetable/preview", headers=headers, json={"sectionId":"CSE-2-A","csv":csv})
    assert preview.status_code == 200
    assert preview.json()["imported"] == 1
    assert client.get("/api/timetable?sectionId=CSE-2-A", headers=headers).json() == []

    imported = client.post("/api/teacher/timetable/upload", headers=headers, json={"sectionId":"CSE-2-A","csv":csv})
    assert imported.status_code == 200
    assert imported.json()["imported"] == 1
    assert any("overlaps another row" in error for error in imported.json()["errors"])

    # A student cannot alter records even if they know a timetable slot and ID.
    assert client.get("/api/teacher/assignments", headers=headers).json()[0]["id"] == "CSE-2-A"

    discussion = client.post("/api/departments/posts", headers=headers, json={
        "kind":"announcement", "title":"Department update", "body":"Meeting at 3 PM."})
    assert discussion.status_code == 200
    post_id = discussion.json()["id"]
    reply = client.post(f"/api/departments/posts/{post_id}/replies", headers=headers, json={"body":"Acknowledged."})
    assert reply.status_code == 200
    assert client.get(f"/api/departments/posts/{post_id}/replies", headers=headers).json()[0]["body"] == "Acknowledged."

    outsider_code = invite("teacher", {"assignments":[{
        "subjectCode":"CS201", "subjectName":"Systems", "branch":"CSE", "year":2, "section":"A"}]})
    outsider = signup_with_verified_email(client, "/api/auth/signup/teacher", {
        "name":"Other Teacher", "email":"other@gmail.com", "password":"long-password-123",
        "departmentName":"", "assignments":[], "inviteCode":outsider_code,
    })
    outsider_headers = {"Authorization":f"Bearer {outsider.json()['token']}"}
    hidden = client.get(f"/api/departments/posts/{post_id}/replies", headers=outsider_headers)
    assert hidden.status_code == 404


def test_date_specific_timetable_changes_override_one_date_only(client):
    code = invite("teacher", {"assignments":[{
        "subjectCode":"CS201", "subjectName":"Systems", "branch":"CSE", "year":2, "section":"A"}]})
    signup = signup_with_verified_email(client, "/api/auth/signup/teacher", {
        "name":"Class Teacher", "email":"class.teacher@gmail.com", "password":"long-password-123",
        "inviteCode":code,
    })
    assert signup.status_code == 200
    teacher_headers = {"Authorization": "Bearer " + signup.json()["token"]}

    today = main.date.today()
    days_until_monday = (8 - today.isoweekday()) % 7 or 7
    target = today + timedelta(days=days_until_monday)
    csv = "day,start,end,subject_code,subject_name,section,room,teacher_email\n" \
          "Mon,09:00,09:50,CS201,Systems,A,R1,class.teacher@gmail.com\n"
    imported = client.post("/api/teacher/timetable/upload", headers=teacher_headers,
                           json={"sectionId":"CSE-2-A", "csv":csv})
    assert imported.status_code == 200
    recurring = client.get("/api/timetable?sectionId=CSE-2-A", headers=teacher_headers).json()
    assert len(recurring) == 1
    base_slot = recurring[0]

    changed = {
        "date":target.isoformat(), "sectionId":"CSE-2-A", "kind":"modify",
        "slotId":base_slot["id"], "startTime":"10:00", "endTime":"10:50", "room":"R2",
    }
    preview = client.post("/api/teacher/timetable/changes/preview", headers=teacher_headers, json=changed)
    assert preview.status_code == 200, preview.text
    assert preview.json()["slot"]["startTime"] == "10:00"
    assert client.get(f"/api/timetable?sectionId=CSE-2-A&date={target.isoformat()}",
                      headers=teacher_headers).json()[0]["startTime"] == "09:00"
    assert client.post("/api/teacher/timetable/changes", headers=teacher_headers, json=changed).status_code == 200

    addition = {
        "date":target.isoformat(), "sectionId":"CSE-2-A", "kind":"add",
        "subjectId":"CS201", "startTime":"11:00", "endTime":"11:50", "room":"R3",
    }
    assert client.post("/api/teacher/timetable/changes/preview", headers=teacher_headers,
                       json={**addition, "startTime":"10:15", "endTime":"11:15"}).status_code == 409
    assert client.post("/api/teacher/timetable/changes", headers=teacher_headers, json=addition).status_code == 200

    effective = client.get(f"/api/timetable?sectionId=CSE-2-A&date={target.isoformat()}",
                           headers=teacher_headers).json()
    assert [(slot["startTime"], slot["room"], slot.get("dateChange")) for slot in effective] == [
        ("10:00", "R2", "modified"), ("11:00", "R3", "added"),
    ]
    assert len(client.get("/api/timetable?sectionId=CSE-2-A", headers=teacher_headers).json()) == 1
    teacher_day = client.get(f"/api/teacher/schedule?date={target.isoformat()}",
                             headers=teacher_headers).json()
    assert {slot["dateChange"] for slot in teacher_day} == {"modified", "added"}

    student = signup_with_verified_email(client, "/api/auth/signup/student", {
        "name":"Test Student", "email":"date.change.student@gmail.com",
        "password":"long-password-123", "branch":"CSE", "year":2, "section":"A",
        "studentId":"S100",
    })
    assert student.status_code == 200
    student_headers = {"Authorization": "Bearer " + student.json()["token"]}
    assert client.patch("/api/teacher/students/S100/enrollment", headers=teacher_headers,
                        json={"sectionId":"CSE-2-A", "status":"approved"}).status_code == 200
    student_day = client.get(f"/api/student/schedule?date={target.isoformat()}",
                             headers=student_headers).json()
    assert [item["slot"]["dateChange"] for item in student_day] == ["modified", "added"]
    extra_slot = next(item["slot"] for item in student_day if item["slot"]["dateChange"] == "added")
    assert client.patch("/api/teacher/attendance", headers=teacher_headers, json={
        "studentId":"S100", "slotId":extra_slot["id"], "date":target.isoformat(),
        "status":"present", "sectionId":"CSE-2-A",
    }).status_code == 422
    assert client.post("/api/teacher/timetable/changes/preview", headers=teacher_headers, json={
        "date":target.isoformat(), "sectionId":"CSE-2-A", "kind":"cancel",
        "slotId":extra_slot["id"],
    }).status_code == 200
    assert client.post("/api/teacher/timetable/changes", headers=teacher_headers, json={
        "date":target.isoformat(), "sectionId":"CSE-2-A", "kind":"cancel",
        "slotId":extra_slot["id"],
    }).status_code == 200
    assert len(client.get(f"/api/timetable?sectionId=CSE-2-A&date={target.isoformat()}",
                          headers=teacher_headers).json()) == 1
    assert client.get(f"/api/teacher/roster?sectionId=CSE-2-A&date={target.isoformat()}&slotId={extra_slot['id']}",
                      headers=teacher_headers).status_code == 409
    assert client.patch("/api/teacher/attendance", headers=teacher_headers, json={
        "studentId":"S100", "slotId":extra_slot["id"], "date":target.isoformat(),
        "status":"present", "sectionId":"CSE-2-A",
    }).status_code == 422
    assert client.post("/api/teacher/timetable/changes/preview", headers=teacher_headers, json={
        **addition, "startTime":"11:00", "endTime":"11:50",
    }).status_code == 409
    retained_csv = "day,start,end,subject_code,subject_name,section,room,teacher_email\n" \
                   "Mon,11:00,11:50,CS201,Systems,A,R3,class.teacher@gmail.com\n"
    retained_import = client.post("/api/teacher/timetable/upload", headers=teacher_headers,
                                  json={"sectionId":"CSE-2-A", "csv":retained_csv})
    assert retained_import.status_code == 200
    assert retained_import.json()["imported"] == 0
    assert any("retained for attendance history" in error for error in retained_import.json()["errors"])

    assert len(client.get("/api/timetable?sectionId=CSE-2-A", headers=teacher_headers).json()) == 1

    days_since_monday = (today.isoweekday() - 1) % 7 or 7
    completion_date = today - timedelta(days=days_since_monday)
    invalid_date = completion_date - timedelta(days=1)
    assert client.patch("/api/teacher/attendance", headers=teacher_headers, json={
        "studentId":"S100", "slotId":base_slot["id"], "date":invalid_date.isoformat(),
        "status":"present", "sectionId":"CSE-2-A",
    }).status_code == 404

    session_state = client.get("/api/teacher/attendance/session", headers=teacher_headers, params={
        "sectionId":"CSE-2-A", "slotId":base_slot["id"], "date":completion_date.isoformat(),
    })
    assert session_state.status_code == 200, session_state.text
    assert session_state.json()["completed"] is False
    assert client.get("/api/student/summary", headers=student_headers).json() == []

    second_student = signup_with_verified_email(client, "/api/auth/signup/student", {
        "name":"Second Student", "email":"second.student@gmail.com",
        "password":"long-password-123", "branch":"CSE", "year":2,
        "section":"A", "studentId":"S200",
    })
    assert second_student.status_code == 200
    second_headers = {"Authorization":"Bearer " + second_student.json()["token"]}
    assert client.patch("/api/teacher/students/S200/enrollment", headers=teacher_headers,
                        json={"sectionId":"CSE-2-A", "status":"approved"}).status_code == 200
    assert client.patch("/api/teacher/attendance", headers=teacher_headers, json={
        "studentId":"S100", "slotId":base_slot["id"], "date":completion_date.isoformat(),
        "status":"present", "sectionId":"CSE-2-A",
    }).status_code == 200
    closed = client.post("/api/teacher/attendance/complete", headers=teacher_headers, json={
        "sectionId":"CSE-2-A", "slotId":base_slot["id"], "date":completion_date.isoformat(),
    })
    assert closed.status_code == 200
    assert closed.json()["absencesAdded"] == 1
    assert client.post("/api/teacher/attendance/complete", headers=teacher_headers, json={
        "sectionId":"CSE-2-A", "slotId":base_slot["id"], "date":completion_date.isoformat(),
    }).json()["absencesAdded"] == 0
    completed_roster = client.get("/api/teacher/roster", headers=teacher_headers, params={
        "sectionId":"CSE-2-A", "slotId":base_slot["id"], "date":completion_date.isoformat(),
    }).json()
    assert {row["studentId"]:row["status"] for row in completed_roster} == {
        "S100":"present", "S200":"absent",
    }
    first_summary = client.get("/api/student/summary", headers=student_headers).json()
    second_summary = client.get("/api/student/summary", headers=second_headers).json()
    assert first_summary[0]["heldCount"] == second_summary[0]["heldCount"] == 1
    assert first_summary[0]["percentage"] == 100
    assert second_summary[0]["percentage"] == 0


def test_completed_sessions_drive_department_analytics_without_join_multiplication(client):
    hod_code = invite("teacher", {"assignments":[{
        "subjectCode":"CS201", "subjectName":"Systems", "branch":"CSE", "year":2, "section":"A",
    }]})
    hod = signup_with_verified_email(client, "/api/auth/signup/teacher", {
        "name":"Department Lead", "email":"hod.analytics@gmail.com",
        "password":"long-password-123", "inviteCode":hod_code,
    })
    assert hod.status_code == 200
    hod_headers = {"Authorization":"Bearer " + hod.json()["token"]}
    department = client.post("/api/departments", headers=hod_headers, json={"name":"Computing"})
    assert department.status_code == 200

    teacher_code = invite("teacher", {"assignments":[{
        "subjectCode":"CS202", "subjectName":"Networks", "branch":"CSE", "year":2, "section":"A",
    }]})
    teacher = signup_with_verified_email(client, "/api/auth/signup/teacher", {
        "name":"Second Teacher", "email":"second.teacher@gmail.com",
        "password":"long-password-123", "inviteCode":teacher_code,
    })
    assert teacher.status_code == 200
    teacher_headers = {"Authorization":"Bearer " + teacher.json()["token"]}
    assert client.post("/api/departments/join", headers=teacher_headers,
                       json={"code":department.json()["joinCode"]}).status_code == 200

    student = signup_with_verified_email(client, "/api/auth/signup/student", {
        "name":"Analytics Student", "email":"analytics.student@gmail.com",
        "password":"long-password-123", "branch":"CSE", "year":2,
        "section":"A", "studentId":"S100",
    })
    assert student.status_code == 200
    assert client.patch("/api/teacher/students/S100/enrollment", headers=hod_headers,
                        json={"sectionId":"CSE-2-A", "status":"approved"}).status_code == 200

    import_one = "day,start,end,subject_code,subject_name,section,room,teacher_email\n" \
                 "Mon,09:00,09:50,CS201,Systems,A,R1,hod.analytics@gmail.com\n"
    import_two = "day,start,end,subject_code,subject_name,section,room,teacher_email\n" \
                 "Mon,10:00,10:50,CS202,Networks,A,R2,second.teacher@gmail.com\n"
    assert client.post("/api/teacher/timetable/upload", headers=hod_headers,
                       json={"sectionId":"CSE-2-A", "csv":import_one}).json()["imported"] == 1
    assert client.post("/api/teacher/timetable/upload", headers=teacher_headers,
                       json={"sectionId":"CSE-2-A", "csv":import_two}).json()["imported"] == 1

    days_since_monday = (main.date.today().isoweekday() - 1) % 7 or 7
    session_date = main.date.today() - timedelta(days=days_since_monday)
    monday_slots = client.get(
        f"/api/teacher/schedule?date={session_date.isoformat()}", headers=hod_headers,
    ).json()
    assert {slot["subjectId"] for slot in monday_slots} == {"CS201", "CS202"}
    for headers, subject_id, status in (
        (hod_headers, "CS201", "present"),
        (teacher_headers, "CS202", "absent"),
    ):
        slot = next(item for item in monday_slots if item["subjectId"] == subject_id)
        if status == "present":
            assert client.patch("/api/teacher/attendance", headers=headers, json={
                "studentId":"S100", "slotId":slot["id"], "date":session_date.isoformat(),
                "status":status, "sectionId":"CSE-2-A",
            }).status_code == 200
        assert client.post("/api/teacher/attendance/complete", headers=headers, json={
            "sectionId":"CSE-2-A", "slotId":slot["id"], "date":session_date.isoformat(),
        }).status_code == 200

    analytics = client.get("/api/departments/analytics", headers=hod_headers)
    assert analytics.status_code == 200
    by_subject = {row["subjectCode"]:row for row in analytics.json()}
    assert by_subject["CS201"]["sessionsHeld"] == 1
    assert by_subject["CS201"]["presentRate"] == 100
    assert by_subject["CS202"]["sessionsHeld"] == 1
    assert by_subject["CS202"]["presentRate"] == 0
    second_slot = next(item for item in monday_slots if item["subjectId"] == "CS202")
    assert client.patch("/api/teacher/attendance", headers=hod_headers, json={
        "studentId":"S100", "slotId":second_slot["id"], "date":session_date.isoformat(),
        "status":"present", "sectionId":"CSE-2-A",
    }).status_code == 403


def test_init_db_backfills_only_fully_marked_legacy_sessions(client):
    with main.connect() as db:
        db.execute(
            "INSERT INTO users(id,email,password_hash,role,name,created_at) VALUES (?,?,?,?,?,?)",
            ("legacy-teacher", "legacy.teacher@gmail.com", "unused", "teacher", "Legacy Teacher", main.now_iso()),
        )
        db.execute("INSERT INTO sections(id,branch,year,section) VALUES ('CSE-2-A','CSE',2,'A')")
        db.execute("INSERT INTO subjects(id,code,name,branch,year) VALUES ('CS201','CS201','Systems','CSE',2)")
        db.execute("INSERT INTO timetable_slots(id,section_id,subject_id,teacher_id,day_of_week,start_time,end_time) "
                    "VALUES ('legacy-full','CSE-2-A','CS201','legacy-teacher',1,'09:00','09:50')")
        db.execute("INSERT INTO timetable_slots(id,section_id,subject_id,teacher_id,day_of_week,start_time,end_time) "
                    "VALUES ('legacy-partial','CSE-2-A','CS201','legacy-teacher',1,'10:00','10:50')")
        for index, student_id in enumerate(("S100", "S200"), start=1):
            user_id = f"legacy-student-{index}"
            db.execute(
                "INSERT INTO users(id,email,password_hash,role,name,created_at) VALUES (?,?,?,?,?,?)",
                (user_id, f"legacy.student{index}@gmail.com", "unused", "student", f"Student {index}", main.now_iso()),
            )
            db.execute(
                "INSERT INTO student_profiles(user_id,student_id,section_id,joined_at,enrollment_status) "
                "VALUES (?,?,? ,?,'approved')",
                (user_id, student_id, "CSE-2-A", main.now_iso()),
            )
            for slot_id in ("legacy-full",) + (("legacy-partial",) if index == 1 else ()):
                db.execute(
                    "INSERT INTO class_attendance(id,student_id,slot_id,date,status,method,marked_by,created_at) "
                    "VALUES (?,?,?,?,?,'manual','legacy-teacher',?)",
                    (main.uid(), student_id, slot_id, "2026-10-12", "present", main.now_iso()),
                )

    main.init_db()
    main.init_db()

    with main.connect() as db:
        sessions = db.execute(
            "SELECT slot_id,COUNT(*) AS count FROM attendance_sessions GROUP BY slot_id"
        ).fetchall()
    assert [(row["slot_id"], row["count"]) for row in sessions] == [("legacy-full", 1)]


def test_camera_attendance_requires_teacher_review_for_exits_and_unobserved_students(client):
    teacher_code = invite("teacher", {"assignments":[{
        "subjectCode":"CS201", "subjectName":"Systems", "branch":"CSE", "year":2, "section":"A",
    }]})
    teacher = signup_with_verified_email(client, "/api/auth/signup/teacher", {
        "name":"Camera Teacher", "email":"camera.teacher@gmail.com",
        "password":"long-password-123", "inviteCode":teacher_code,
    })
    assert teacher.status_code == 200
    headers = {"Authorization":"Bearer " + teacher.json()["token"]}

    for student_id, email in (
        ("S100","camera.s100@gmail.com"),
        ("S200","camera.s200@gmail.com"),
        ("S300","camera.s300@gmail.com"),
    ):
        student = signup_with_verified_email(client, "/api/auth/signup/student", {
            "name":f"Student {student_id}", "email":email, "password":"long-password-123",
            "branch":"CSE", "year":2, "section":"A", "studentId":student_id,
        })
        assert student.status_code == 200
        assert client.patch(f"/api/teacher/students/{student_id}/enrollment", headers=headers,
            json={"sectionId":"CSE-2-A", "status":"approved"}).status_code == 200

    csv_text = "day,start,end,subject_code,subject_name,section,room,teacher_email\n" \
               "Mon,09:00,10:00,CS201,Systems,A,R1,camera.teacher@gmail.com\n"
    assert client.post("/api/teacher/timetable/upload", headers=headers,
        json={"sectionId":"CSE-2-A", "csv":csv_text}).json()["imported"] == 1
    days_since_monday = (main.date.today().isoweekday() - 1) % 7 or 7
    session_date = main.date.today() - timedelta(days=days_since_monday)
    slot = client.get(f"/api/teacher/schedule?date={session_date.isoformat()}",
                      headers=headers).json()[0]
    with main.connect() as db:
        main.record_camera_run(
            db, "CSE-2-A", slot["id"], session_date, "entry-camera", "entry",
            datetime.combine(session_date, time(9, 0)),
        )
        assert main.record_camera_attendance_event(
            db, "CSE-2-A", slot, session_date, "S100", "entry-camera", "entry",
            datetime.combine(session_date, time(9, 2)), 0.8,
        )
        assert main.record_camera_attendance_event(
            db, "CSE-2-A", slot, session_date, "S100", "exit-camera", "exit",
            datetime.combine(session_date, time(9, 30)), 0.8,
        )
        assert main.record_camera_attendance_event(
            db, "CSE-2-A", slot, session_date, "S200", "entry-camera", "entry",
            datetime.combine(session_date, time(9, 15)), 0.8,
        )

    first_completion = client.post("/api/teacher/attendance/complete", headers=headers, json={
        "sectionId":"CSE-2-A", "slotId":slot["id"], "date":session_date.isoformat(),
    })
    assert first_completion.status_code == 200
    assert first_completion.json() == {
        "completed":False, "completedAt":None, "absencesAdded":0, "reviewRequired":2,
    }
    roster = client.get("/api/teacher/roster", headers=headers, params={
        "sectionId":"CSE-2-A", "slotId":slot["id"], "date":session_date.isoformat(),
    }).json()
    by_student = {row["studentId"]:row for row in roster}
    assert by_student["S100"]["status"] == "present"
    assert by_student["S100"]["reviewRequired"] is True
    assert by_student["S100"]["reviewReason"] == "early_exit"
    assert by_student["S200"]["status"] == "late"
    assert by_student["S200"]["reviewRequired"] is False
    assert by_student["S300"]["status"] == "unmarked"
    assert by_student["S300"]["reviewRequired"] is True
    assert by_student["S300"]["reviewReason"] == "not_observed"

    assert client.patch("/api/teacher/attendance", headers=headers, json={
        "studentId":"S100", "slotId":slot["id"], "date":session_date.isoformat(),
        "status":"present", "sectionId":"CSE-2-A",
    }).status_code == 200
    assert client.patch("/api/teacher/attendance", headers=headers, json={
        "studentId":"S300", "slotId":slot["id"], "date":session_date.isoformat(),
        "status":"absent", "sectionId":"CSE-2-A",
    }).status_code == 200
    completed = client.post("/api/teacher/attendance/complete", headers=headers, json={
        "sectionId":"CSE-2-A", "slotId":slot["id"], "date":session_date.isoformat(),
    })
    assert completed.status_code == 200
    assert completed.json()["completed"] is True
    assert completed.json()["absencesAdded"] == 0
    with main.connect() as db:
        assert not main.record_camera_attendance_event(
            db, "CSE-2-A", slot, session_date, "S200", "late-camera", "entry",
            datetime.combine(session_date, time(9, 20)), 0.8,
        )


def test_camera_source_accepts_camera_indexes_and_stream_urls():
    assert parse_source("0") == 0
    assert parse_source("-1") == -1
    assert parse_source("rtsp://camera/stream") == "rtsp://camera/stream"
    assert parse_source("C:\\videos\\class.mp4") == "C:\\videos\\class.mp4"
