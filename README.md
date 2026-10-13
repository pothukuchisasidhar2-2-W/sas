# True Eye

True Eye adds a web application and role controlled API around the existing
local face attendance project. The existing YuNet/SFace recognition scripts,
ONNX models, and SQLite `students`, `attendance`, and `student_embeddings`
tables remain in place. The API adds its own tables to that same database.

## Current architecture

- `web/`: React, TypeScript, Vite, and Tailwind interface.
- `api/main.py`: FastAPI service, password hashing, short lived bearer sessions,
  access checks, timetable import, department collaboration, and recognition
  enrollment endpoint.
- `attendance.db`: shared local SQLite database. Never place it under `web/`.
- `scripts/core/`: original webcam registration and recognition tools.
- `scripts/admin/create_invite.py`: operator only command to issue teacher
  activation codes. Codes expire after seven days and can be redeemed once.

The web app does not read SQLite itself. Run the API and Vite development
server on the same computer as the database and camera. The API can read legacy
attendance rows, but those rows have no subject or class association. True Eye
labels those rows as unassigned and does not derive subject percentages from
them. Class specific attendance comes only from explicitly marked scheduled
periods.

## Install and start

Use the project virtual environment if available, then install Python
dependencies:

```powershell
python -m pip install -r requirements.txt
```

Start the API from the repository root:

```powershell
python -m uvicorn api.main:app --reload --host 127.0.0.1 --port 8000
```

In another terminal, configure the frontend and start Vite:

```powershell
Set-Location .\web
Copy-Item .env.example .env.local
npm ci
npm run dev
```

Open the local URL printed by Vite. With `VITE_API_URL` unset, the frontend
uses its in-browser demo store; demo accounts and generated data are for UI
preview only. For real data, set `VITE_API_URL=http://127.0.0.1:8000` before
starting Vite.

## Operator account setup

Students self-register with their name, email, roll number, branch, year and
section. The class request starts pending. The face capture screen sends one
still image to the local API, which detects a face and stores its YuNet/SFace
embedding in the existing `students` row. Existing face IDs are matched against
the captured face before an account can reuse them. A teacher assigned to that
class approves or rejects membership in **Teacher / Attendance monitoring**.
Pending and rejected students cannot access attendance or be marked present.

Teacher accounts remain institution controlled. An operator with local access
creates one-time activation codes for approved teacher assignments. To issue a
teacher invitation:

```powershell
python scripts/admin/create_invite.py teacher
```

The operator enters the department and each approved subject/class assignment.
Those approved values, not values supplied by the browser, determine teacher
permissions. The first teacher invited with a department name is its department
lead. Further teachers can join using a department invitation code.

For a local test pair, run `python scripts/admin/seed_demo_accounts.py` and
choose passwords when prompted. It creates `demo.student@trueeye.local` and
`demo.teacher@trueeye.local` for `CSE-AIDS-2-A`; the student starts pending so
the teacher can test approval and removal. The student still needs to capture a
face before camera recognition can identify that demo roll number. Do not use
these accounts on a production database.

## Timetables and attendance

Teachers can import CSV from **Teacher → Timetable**. Review a validation
preview before confirming the save. Invalid and conflicting rows are listed,
and only the valid rows confirmed in that preview are written. The header must be:

```csv
day,start,end,subject_code,subject_name,section,room,teacher_email
```

Use Monday through Saturday, 24 hour `HH:MM` times, an assigned subject and
section, and the teacher's own email. Invalid or conflicting rows are reported
and not imported.

The existing `liv_recog.py` process continues to mark one legacy attendance
row per student per date. It does not know which class is in session, so it
cannot safely assign that mark to a timetable slot. Teachers can mark a
scheduled period through the web roster; these records are stored separately
with their class and subject association. Remote camera start/stop and live
session control are not implemented.

## Configuration

Copy `.env.example` as a reference. Set `TRUE_EYE_DB` to select the SQLite file
and `TRUE_EYE_CORS_ORIGINS` to a comma separated list of allowed frontend
origins. The frontend reads `VITE_API_URL` and `VITE_ATTENDANCE_THRESHOLD` from
`web/.env.local`. Keep production secrets, database files, and `.env.local`
outside version control.

Signup accepts Gmail addresses only and requires a one-time inbox code before
creating an account. Password reset also uses a one-time Gmail code. Configure
`TRUE_EYE_GMAIL_ADDRESS` and `TRUE_EYE_GMAIL_APP_PASSWORD` on the API host;
the password must be a Google App Password, and these values must never be
committed. Codes expire after ten minutes and resend is rate limited.

API bearer tokens expire after 30 days and are restored from browser local
storage when the site opens, so users remain signed in across reloads during
that period. Passwords use PBKDF2-HMAC-SHA256. Deployments exposed beyond a
trusted local network should review the complete session and browser security
model before use. There is no admin portal, liveness detection, or biometric retention scheduler. Face
embeddings remain sensitive biometric data in the local SQLite file.

## Verification

Run the backend suite and existing recognition-store diagnostic with:

```powershell
python -m pytest tests
python scripts/diag/test_ref_store.py
```

Build and lint the UI from `web/` with `npm run build` and `npm run lint`.
