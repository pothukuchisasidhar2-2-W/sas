import json
import tempfile
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api import main


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


def test_student_invite_links_only_its_existing_attendance_identity(client):
    code = invite("student", {"studentId":"S100","branch":"CSE","year":2,"section":"A"})
    response = client.post("/api/auth/signup/student", json={
        "name":"Test Student", "email":"student@example.test", "password":"long-password-123",
        "branch":"CSE", "year":2, "section":"A", "studentId":"S100", "inviteCode":code,
    })
    assert response.status_code == 200
    token = response.json()["token"]
    assert response.json()["user"]["profile"]["studentId"] == "S100"
    assert "embedding" not in response.text

    attendance = client.get("/api/student/attendance?from=2026-10-01&to=2026-10-31", headers={"Authorization":f"Bearer {token}"})
    assert attendance.status_code == 200
    assert [row["studentId"] for row in attendance.json()] == ["S100"]
    assert attendance.json()[0]["subjectId"] == ""

    forbidden = client.get("/api/teacher/assignments", headers={"Authorization":f"Bearer {token}"})
    assert forbidden.status_code == 403
    reused = client.post("/api/auth/signup/student", json={
        "name":"Another", "email":"another@example.test", "password":"long-password-123",
        "branch":"CSE", "year":2, "section":"A", "studentId":"S100", "inviteCode":code,
    })
    assert reused.status_code == 403


def test_teacher_scope_and_timetable_import_validation(client):
    code = invite("teacher", {"departmentName":"Computing", "assignments":[{
        "subjectCode":"CS201", "subjectName":"Systems", "branch":"CSE", "year":2, "section":"A"}]})
    signup = client.post("/api/auth/signup/teacher", json={
        "name":"Test Teacher", "email":"teacher@example.test", "password":"long-password-123",
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
          "Mon,09:00,09:50,CS201,Systems,A,R1,teacher@example.test\n" \
          "Mon,09:30,10:00,CS201,Systems,A,R1,teacher@example.test\n"
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
    outsider = client.post("/api/auth/signup/teacher", json={
        "name":"Other Teacher", "email":"other@example.test", "password":"long-password-123",
        "departmentName":"", "assignments":[], "inviteCode":outsider_code,
    })
    outsider_headers = {"Authorization":f"Bearer {outsider.json()['token']}"}
    hidden = client.get(f"/api/departments/posts/{post_id}/replies", headers=outsider_headers)
    assert hidden.status_code == 404
