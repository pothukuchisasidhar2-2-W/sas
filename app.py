
from flask import Flask, render_template, redirect, url_for, flash, request
import sqlite3
import subprocess
import sys
import os
from pathlib import Path
from datetime import date

from firebase_db import db, add_student, get_students, update_student, delete_student

app = Flask(__name__)
app.secret_key = os.environ.get(
    "FLASK_SECRET_KEY", "change-this-secret-before-deployment"
)

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "attendance.db"
running_processes = {}


def get_connection():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def launch_script(script_name):
    script_path = BASE_DIR / script_name
    if not script_path.is_file():
        return False, f"Could not find {script_name} in {BASE_DIR}"

    process = running_processes.get(script_name)
    if process is not None and process.poll() is None:
        return False, f"{script_name} is already running."

    try:
        options = {}
        if os.name == "nt":
            options["creationflags"] = subprocess.CREATE_NEW_CONSOLE

        process = subprocess.Popen(
            [sys.executable, str(script_path)],
            cwd=str(BASE_DIR),
            **options
        )
        running_processes[script_name] = process
        return True, f"{script_name} launched successfully."
    except Exception as error:
        return False, f"Could not launch {script_name}: {error}"


@app.route("/")
def dashboard():
    connection = get_connection()
    today = date.today().isoformat()

    try:
        total_students = len(get_students())
    except Exception as error:
        connection.close()
        app.logger.exception("Could not read students from Firestore")
        flash(f"Could not load Firebase student data: {error}", "error")
        return render_template(
            "index.html",
            page="dashboard",
            total_students=0,
            today_count=0,
            recent_attendance=[],
            today=today
        )

    today_count = connection.execute(
        "SELECT COUNT(*) FROM attendance WHERE date = ?", (today,)
    ).fetchone()[0]

    recent_attendance = connection.execute("""
        SELECT a.student_id, s.name, a.date, a.in_time, a.out_time
        FROM attendance AS a
        LEFT JOIN students AS s ON s.student_id = a.student_id
        ORDER BY a.id DESC
        LIMIT 10
    """).fetchall()

    connection.close()

    return render_template(
        "index.html",
        page="dashboard",
        total_students=total_students,
        today_count=today_count,
        recent_attendance=recent_attendance,
        today=today
    )


@app.route("/register", methods=["GET", "POST"])
def register_page():
    if request.method == "POST":
        ok, message = launch_script("register.py")
        flash(message, "success" if ok else "error")
        return redirect(url_for("register_page"))
    return render_template("index.html", page="register")


@app.route("/recognition", methods=["GET", "POST"])
def recognition_page():
    if request.method == "POST":
        ok, message = launch_script("liv_recog.py")
        flash(message, "success" if ok else "error")
        return redirect(url_for("recognition_page"))
    return render_template("index.html", page="recognition")


@app.route("/attendance")
def attendance_page():
    connection = get_connection()
    records = connection.execute("""
        SELECT a.student_id, s.name, a.date, a.in_time, a.out_time
        FROM attendance AS a
        LEFT JOIN students AS s ON s.student_id = a.student_id
        ORDER BY a.id DESC
    """).fetchall()
    connection.close()

    return render_template("index.html", page="attendance", records=records)


@app.route("/students")
def students_page():
    try:
        students = get_students()
        students.sort(key=lambda student: student.get("name", "").lower())
        return render_template(
            "index.html", page="students", students=students
        )
    except Exception:
        app.logger.exception("Could not load Firestore students")
        flash("Could not load students from Firebase. Check the server console.", "error")
        return render_template("index.html", page="students", students=[])


@app.route("/students/<student_id>/edit", methods=["POST"])
def edit_student(student_id):
    name = request.form.get("name", "").strip()

    if not name:
        flash("Student name cannot be empty.", "error")
        return redirect(url_for("students_page"))

    try:
        # Update the Firestore student document.
        update_student(student_id, name)

        # Keep the local face-recognition database name in sync.
        connection = get_connection()
        connection.execute(
            "UPDATE students SET name = ? WHERE student_id = ?",
            (name, student_id)
        )
        connection.commit()
        connection.close()

        flash("Student name updated successfully.", "success")
    except Exception:
        app.logger.exception("Student update failed")
        flash("Could not update student. Check the server console.", "error")

    return redirect(url_for("students_page"))


@app.route("/students/<student_id>/delete", methods=["POST"])
def remove_student(student_id):
    try:
        # Delete the Firestore student document.
        delete_student(student_id)

        # Remove the local face embedding so this student is not recognized.
        connection = get_connection()
        connection.execute(
            "DELETE FROM students WHERE student_id = ?", (student_id,)
        )
        connection.commit()
        connection.close()

        # Attendance history is deliberately preserved.
        flash("Student deleted. Attendance history was preserved.", "success")
    except Exception:
        app.logger.exception("Student deletion failed")
        flash("Could not delete student. Check the server console.", "error")

    return redirect(url_for("students_page"))


@app.route("/health")
def health():
    return {"status": "ok", "database": DB_PATH.exists()}


if __name__ == "__main__":
    app.run(debug=True)
