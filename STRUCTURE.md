# True Eye — project map for future work

This is the maintained orientation guide for the repository. Read it with
`README.md`: the README covers product behavior and setup; this file explains
where code lives, how the main pieces connect, and which assumptions matter
when changing them.

## What this project is

True Eye is a local-first attendance app with a React web client, a FastAPI
service, a shared SQLite database, and optional OpenCV face enrollment and
camera recognition. The browser never reads the database directly. The API
serves both the web app and the camera process.

## Repository map

```text
api/
  main.py                  FastAPI routes, auth, schema, permissions, attendance,
                           timetable, department features, and face enrollment
db/
  database.py              Legacy/base SQLite table bootstrap
models/                    YuNet detector and SFace recognizer ONNX files
scripts/
  core/register.py         Interactive webcam face enrollment (legacy workflow)
  core/liv_recog.py        Timetable-aware entry/exit camera event process
  core/ref_store.py        Matching and bounded harvested embedding storage
  admin/create_invite.py   Operator command to issue teacher activation codes
  admin/seed_demo_accounts.py  Local demo student/teacher account setup
  diag/                    Camera, model, and database diagnostics
tests/test_api.py          API integration tests with isolated temporary DBs
web/
  src/App.tsx              Route tree and role-protected route shells
  src/api/client.ts        HTTP client and mock/real API switch
  src/api/contract.ts      API interface consumed by UI pages
  src/api/mock.ts          In-browser demo store used without VITE_API_URL
  src/api/types.ts         Shared frontend domain types
  src/lib/auth.tsx         Session state, sign-in/out, user role context
  src/lib/useApiData.ts    Shared data-loading hooks
  src/pages/               Public, student, and teacher screens
  src/components/          Shared UI, webcam, and date components
  src/layouts/             Student and teacher navigation shells
  vite.config.ts           Vite dev server and /api proxy
attendance.db              Local runtime database; ignored by git
README.md                  Setup, product workflows, configuration, verification
STRUCTURE.md               This developer orientation guide
```

## Main request and data flows

### Web requests

`web/src/App.tsx` owns route guards. `auth.tsx` holds the signed-in user and
restores the bearer token from browser local storage. Pages call functions in
`web/src/api/contract.ts`; `web/src/api/client.ts` implements them. If
`VITE_API_URL` is empty, calls use `mock.ts`; if it is set, calls go to FastAPI.
Keep the contract, client, and route response shapes aligned when changing an
API feature.

The Vite config proxies `/api` to `127.0.0.1:8000`, but the checked-in example
frontend config sets `VITE_API_URL=http://127.0.0.1:8000`, which makes browser
requests cross-origin. FastAPI's default CORS allowlist includes only
`localhost:5173` and `127.0.0.1:5173`. If Vite falls back to another port
(because 5173 is occupied), add that exact origin to `TRUE_EYE_CORS_ORIGINS` or
free port 5173. A working API health check alone does not rule out a browser
CORS failure.

### API and SQLite

`api/main.py` is currently the main backend module: it defines additive schema
creation, request models, password/session helpers, role checks, and route
handlers. The API's `init_db()` creates/extends application tables in the same
SQLite file as legacy `students`, `attendance`, and `student_embeddings` data.
`TRUE_EYE_DB` selects the database; by default it is `attendance.db` beside
`api/`. Keep the API and camera process pointed at the same DB.

Google Identity Services supplies a signed identity credential. The API
validates its signature, audience, nonce, and verified-email claim using
`GOOGLE_CLIENT_ID`; the browser uses the same public ID as
`VITE_GOOGLE_CLIENT_ID`. Signup collects normal account credentials and uses
Google OAuth to verify that the user controls the same email address. Password
and Google sign-in are both available afterward. New student registration
collects college, branch, year, section, and roll number. Class membership
starts pending. Teacher registration still requires an operator-issued,
single-use invite with approved department/assignment data. Gmail SMTP
credentials remain for password reset.

Feature route groups are: `/api/auth/*`, `/api/student/*`, `/api/teacher/*`,
`/api/timetable`, `/api/directory/*`, and `/api/departments/*`. Read the
corresponding handler and permission dependency in `api/main.py` before changing
authorization or persistence behavior; UI hiding is not an authorization rule.

### Face enrollment and camera attendance

`api/main.py` loads YuNet and SFace model files from `models/` for the student
enrollment endpoint. It stores the canonical face embedding on the existing
`students` row. `scripts/core/register.py` is the separate webcam registration
utility and also writes to that legacy table.

`scripts/core/liv_recog.py` loads approved students for a section, matches
sampled camera frames against canonical and harvested SFace embeddings, then
records confirmed entry/exit events through shared API/database helpers. It
checks the effective timetable and records camera heartbeats. Missing
observations and early exits are flagged for a teacher to review; camera
non-detection by itself is not an absence. It accepts a camera index, stream
URL, or video path and requires a section ID. The API camera routes expose
USB devices and operator-configured IP streams while checking teacher section
assignments. The recognition worker publishes transient annotated JPEG frames
to an owner-scoped API preview stream; it does not persist video. Keep IP
stream URLs in the API host's `TRUE_EYE_IP_CAMERAS_JSON` environment, never in
browser responses; see README for the configuration shape.
The teacher camera page can run one distinct entry camera and one distinct exit
camera for a section at the same time and shows both live previews. A missing
recognition remains unobserved for teacher review; only the attendance roster
workflow can apply a confirmed manual absent mark.

`scripts/core/ref_store.py` contains the pure matching/SQLite helper logic.
Harvested references are additional to the canonical `students.embedding`:
the store accepts high-confidence, non-duplicate examples, caps references at
four per student, and may replace a redundant reference. Re-registration clears
that student's harvested references.

## Local commands

Run commands from `cam_recognization/` unless noted. On Windows, the workspace
virtual environment is one directory above this repo (`..\venv`):

```powershell
..\venv\Scripts\python.exe -m uvicorn api.main:app --reload --host 127.0.0.1 --port 8000
```

In another terminal:

```powershell
Set-Location web
npm run dev -- --host 127.0.0.1
```

Use the Vite URL printed in the terminal. For a real API-backed browser
session, its origin must be in `TRUE_EYE_CORS_ORIGINS`; the default is port
5173. For the frontend's mock preview, remove `VITE_API_URL` from
`web/.env.local` and restart Vite.

Other useful commands:

```powershell
# From cam_recognization/
python -m pytest tests
python scripts/diag/test_ref_store.py
python scripts/admin/create_invite.py teacher
python scripts/admin/seed_demo_accounts.py

# From cam_recognization/web/
npm run build
npm run lint
```

Do not seed demo accounts or run camera enrollment against data that should be
kept unchanged. The seed script updates the selected database and resets the
demo passwords to the values entered interactively.

## Environment and local state

- API: `TRUE_EYE_DB`, `TRUE_EYE_CORS_ORIGINS`,
  `TRUE_EYE_ATTENDANCE_THRESHOLD`, `GOOGLE_CLIENT_ID`,
  `TRUE_EYE_GMAIL_ADDRESS`, `TRUE_EYE_GMAIL_APP_PASSWORD` (password reset).
- Camera: `TRUE_EYE_CAMERA_SOURCE`, `TRUE_EYE_CAMERA_SECTION`,
  `TRUE_EYE_CAMERA_ID`, `TRUE_EYE_CAMERA_EVENT_TYPE`,
  `TRUE_EYE_LATE_GRACE_MINUTES`,
  `TRUE_EYE_EARLY_EXIT_REVIEW_MINUTES`, `TRUE_EYE_FACE_MATCH_THRESHOLD`.
- Web: `VITE_API_URL`, `VITE_ATTENDANCE_THRESHOLD`, `VITE_GOOGLE_CLIENT_ID` in ignored
  `web/.env.local`.
- `attendance.db`, SQLite WAL files, Python caches, `web/node_modules`,
  `web/dist`, and local `.env` files are intentionally ignored/generated.
  Never commit real account data, Gmail credentials, camera credentials, or
  database files.

## Change guide

- API behavior or permissions: update `api/main.py`, then its API tests and the
  relevant frontend contract/client/page.
- UI only: work in the matching `web/src/pages/` area; shared visual building
  blocks belong in `components/`, session/navigation in `lib/` and `layouts/`.
- Camera matching or enrollment: keep SFace vector format compatible with
  existing `students.embedding` blobs and `student_embeddings` rows.
- Database changes: preserve legacy attendance tables and treat application
  tables as additive. The camera script imports API helpers, so avoid creating a
  second competing database implementation.
- Timetable/attendance: recurring slots, one-date overrides, camera events, and
  completed attendance sessions are separate concepts; inspect their existing
  handlers before changing summaries or absence rules.

## Repository state note

At the time this guide was written, the working tree already contained local
edits in README, API, camera, tests, and several web files. Those changes were
left untouched. Re-check `git status` before editing so existing work is not
mistaken for clean baseline code.
