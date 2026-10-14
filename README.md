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

Teachers can import a CSV file or paste CSV text in **Teacher → Timetable**.
The page provides a downloadable template with the selected class and teacher
pre-filled. Teachers using Excel should save/export the sheet as **CSV UTF-8**
before importing; `.xlsx` workbooks are not supported yet. Review the validation
preview before confirming the save. Invalid and conflicting rows are listed,
and only the valid rows confirmed in that preview are written. The header must be:

```csv
day,start,end,subject_code,subject_name,section,room,teacher_email
```

Use Monday through Saturday, 24 hour `HH:MM` times, an assigned subject and
section, and the teacher's own email. Invalid or conflicting rows are reported
and not imported.

For a sudden change, use **Teacher → Timetable → One-time change** instead of
re-uploading the weekly schedule. Teachers can cancel a period, change its time
or room, or add an extra period for a selected date. An extra period can also be
cancelled from that date's schedule. The app previews the change, checks for
class and teacher schedule conflicts, and publishes it only after confirmation.
Students and teachers see the adjusted schedule on that date; the recurring
weekly timetable remains unchanged.

Teachers can record attendance against a scheduled period through the web
roster. In a manual-only session, completing the period records remaining
unmarked, approved students absent. In a camera-assisted session, unobserved
students and early exits are sent to the teacher for review; the period cannot
be completed until each flagged student has a teacher-confirmed mark. A
recognized entry records present or late (10-minute arrival grace by default).
An exit at least five minutes before the scheduled end is flagged for review,
not automatically treated as an absence. Teachers can still correct marks
after completion. Only completed sessions are included in class attendance
percentages and department analytics.

`scripts/core/liv_recog.py` can read a USB camera index, an OpenCV-readable
RTSP/HTTP stream, or a video file. Run one process per entry or exit camera,
with a camera ID and the class section configured. For example, in PowerShell:

```powershell
$env:TRUE_EYE_CAMERA_SOURCE = "rtsp://camera-host/stream"
$env:TRUE_EYE_CAMERA_SECTION = "CSE-2-A"
$env:TRUE_EYE_CAMERA_ID = "cse2a-entry"
$env:TRUE_EYE_CAMERA_EVENT_TYPE = "entry"
python scripts/core/liv_recog.py --headless
```

For a separate exit camera, set its source, ID, and
`TRUE_EYE_CAMERA_EVENT_TYPE` to `exit` before launching another process.
Available settings include `TRUE_EYE_DB`, `TRUE_EYE_LATE_GRACE_MINUTES`,
`TRUE_EYE_EARLY_EXIT_REVIEW_MINUTES`, and `TRUE_EYE_FACE_MATCH_THRESHOLD`.
Use camera-provided RTSP/HTTP stream URLs; ONVIF discovery and proprietary
camera protocols are not implemented. The script does not save frames or
write a per-frame stream of zeroes: it stores confirmed, timestamped
recognition events, while missed detections, feed outages, and unobserved
students remain uncertain and require teacher review. Keep camera credentials
out of source control and shared shell history.

For the first pilot, standard IP CCTV cameras with accessible RTSP streams
(and ONVIF support for discovery/configuration where available) are a better
fit than buying separate IoT/AI cameras. Use distinct entrance and exit views;
test stream access, lighting, face size, and recognition accuracy on site
before relying on the events for attendance. Whole-room continuous CCTV can
be considered later, but a student not visible in a frame is not, by itself,
evidence of absence.

## Configuration

Copy `.env.example` as a reference. Set `TRUE_EYE_DB` to select the SQLite file
and `TRUE_EYE_CORS_ORIGINS` to a comma separated list of allowed frontend
origins. The frontend reads `VITE_API_URL` and `VITE_ATTENDANCE_THRESHOLD` from
`web/.env.local`. Keep production secrets, database files, and `.env.local`
outside version control.

Signup collects the user's name, email, password, and institution details.
Google Identity Services verifies that the signup email belongs to the user;
the password remains available for regular sign-in. On the separate sign-in
page, users can sign in with their password or Google OAuth. Student class
membership still starts pending. Teacher signup still requires an
operator-issued activation code. Signup verification does not require a Gmail
sender or App Password.

Create a Web OAuth client in Google Cloud Console. Add the exact frontend
origins (for local development, `http://127.0.0.1:5173` and
`http://localhost:5173`) to its authorized JavaScript origins. Set the client ID
as both `GOOGLE_CLIENT_ID` in the API environment and `VITE_GOOGLE_CLIENT_ID`
in `web/.env.local`. The same production client ID goes in both environments;
add the deployed frontend origin in Google Cloud Console. The client ID is
public and safe to place in frontend config; this popup flow does not use a
client secret. If the OAuth consent screen is in Testing, add each
Google account used for sign-in as a test user. This Google Identity Services
popup flow does not need an OAuth client secret or redirect URI.

Password reset for existing password-based accounts still uses Gmail SMTP.
Configure `TRUE_EYE_GMAIL_ADDRESS` and `TRUE_EYE_GMAIL_APP_PASSWORD` on the API
host for that feature. The password must be a Google App Password; never commit
it.

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
