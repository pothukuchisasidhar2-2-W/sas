# Smart Attendance — Project Layout & Reading Guide

One-line summary: a local, OpenCV-based face attendance system.
Enroll a face → store its embedding → watch a webcam → recognize → log attendance
into a SQLite database. Everything runs on the desktop; there is no server yet
(`backend.py` is currently empty).

---

## How to read this repo (fast)

Two things flow through the whole project:

- a **face embedding** (a numeric vector produced by the SFace model), and
- a **SQLite database** (`attendance.db`) with two tables: `students` and `attendance`.

If you keep those two in mind, every script makes sense.

---

## File map (group by role, not alphabetically)

### Core pipeline

- `liv_recog.py` — the real attendance program.
  Webcam → detect faces (YuNet) → embed each face (SFace) → cosine-match against
  every enrolled student → if best score ≥ 0.363, mark that student present for
  today (once per day). This is the file to read first.
- `register.py` — enrollment. Prompts for Student ID + Name, opens the webcam,
  and on S/Space captures the largest detected face, extracts its embedding,
  and writes `(student_id, name, embedding)` into `students`.
- `database.py` — schema bootstrap. Creates `attendance.db` and the two tables if
  they do not exist. Run once to initialize.

### Diagnostics / dev helpers (independent scripts)

- `face_dec.py` — face detection only. Red boxes + confidence. No recognition,
  no DB. Useful for checking whether the detector sees you at all.
- `facereg.py` — live embedding viewer. Detects faces, generates embeddings, and
  prints them to the console while showing a "Embedding generated!" label. No
  matching, no DB.
- `camtest.py` — raw webcam sanity check at 1920×1080. No models at all.
- `check_db.py` — prints every enrolled student: ID, name, embedding byte size.

### Models

- `models/face_detection_yunet_2026may.onnx` — YuNet face detector.
- `models/face_recognition_sface_2021dec.onnx` — SFace face recognizer (used for
  alignment, embedding, and cosine matching).

### Data

- `attendance.db` — runtime state. Created/updated by the scripts above; not a
  source file.

### Empty / placeholder

- `backend.py` — currently empty. Likely intended as a future HTTP/API layer on
  top of this local pipeline.

---

## What moves where, in the real pipeline

Day-to-day usage order:

```
database.py          # once, to create the DB
register.py          # once per student, to enroll a face
liv_recog.py         # the running attendance watcher
check_db.py          # optional, to inspect who is enrolled
```

Supporting scripts are independent and can be run in any order for debugging:

```
camtest.py           # is the camera okay?
face_dec.py          # does the detector find faces?
facereg.py           # what do live embeddings look like?
```

---

## What each script touches

| Script | Camera | YuNet | SFace | DB read | DB write | Console UI | Webcam window |
|---|---|---|---|---|---|---|---|
| `liv_recog.py` | yes | yes | yes | yes | yes | yes | yes |
| `register.py` | yes | yes | yes | no | yes | yes | yes |
| `facereg.py` | yes | yes | yes | no | no | yes | yes |
| `face_dec.py` | yes | yes | no | no | no | yes | yes |
| `camtest.py` | yes | no | no | no | no | minimal | yes |
| `check_db.py` | no | no | no | yes | no | yes | no |
| `database.py` | no | no | no | no | yes (schema) | yes | no |

---

## Where the important numbers live

- **Recognition threshold**: `0.363` cosine similarity, hardcoded in `liv_recog.py`.
- **Match method**: `cv2.FaceRecognizerSF_FR_COSINE` (cosine similarity).
- **Enrollment write**: `INSERT OR REPLACE INTO students`.
- **Attendance write guard**: one `in_time` per `(student_id, date)` per day;
  `out_time` stays `NULL` today.
- **Camera**: `cv2.VideoCapture(0)` everywhere; `camtest.py` sets 1920×1080,
  others use native resolution.

---

## Where to start reading code

- Understand the whole system: `liv_recog.py` top to bottom.
- Understand enrollment: `register.py`.
- Understand the data shape: `database.py` + `check_db.py`.
- Understand the models in use: the two `cv2.FaceDetectorYN.create` /
  `cv2.FaceRecognizerSF.create` blocks in `liv_recog.py` and `register.py`.

---

## Things this layout makes visible

- The project is **local-first and script-driven**, not a service.
- Recognition and enrollment share the **same two ONNX models** and the same
  SFace embedding path, so matching is comparing like-with-like.
- Matching is a **linear scan over enrolled students per face per frame**.
- Today's system records **in only**; there is no checkout path yet.
- `backend.py` is the obvious next structural piece if you want an API.

---

## Optional next structure (not done yet)

If the project grows, a natural next layout would be:

- `scripts/` — the standalone OpenCV programs above
- `models/` — already exists
- `db/` or a schema module — instead of `database.py` as a one-shot script
- `backend.py` or `api/` — the HTTP layer when you want one
- `README.md` — this guide, plus run instructions and dependencies

That reorganization can be done without touching the scripts themselves;
this doc is the lightweight version of that, added on top.
