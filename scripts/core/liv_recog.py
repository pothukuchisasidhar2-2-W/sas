"""Timetable-aware attendance capture from USB, IP CCTV, or video sources."""

from __future__ import annotations

import argparse
import os
import sys
import time as monotonic_time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, time, timedelta
from pathlib import Path

import cv2
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from api import main as api

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ref_store

YUNET_MODEL = PROJECT_ROOT / "models" / "face_detection_yunet_2026may.onnx"
SFACE_MODEL = PROJECT_ROOT / "models" / "face_recognition_sface_2021dec.onnx"


def parse_source(value: str) -> int | str:
    """Convert numeric camera indexes while leaving stream URLs and file paths intact."""
    stripped = value.strip()
    if stripped.lstrip("-").isdigit():
        return int(stripped)
    return stripped


def options() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Record timetable-linked student recognition events from a camera stream.",
    )
    parser.add_argument(
        "--source",
        default=os.environ.get("TRUE_EYE_CAMERA_SOURCE", "0"),
        help="OpenCV camera index, RTSP/HTTP stream URL, or video path (default: env or 0).",
    )
    parser.add_argument(
        "--section-id",
        default=os.environ.get("TRUE_EYE_CAMERA_SECTION", ""),
        help="Class section this camera serves, e.g. CSE-2-A (required).",
    )
    parser.add_argument(
        "--camera-id",
        default=os.environ.get("TRUE_EYE_CAMERA_ID", "camera-1"),
        help="Stable, non-secret identifier for this camera.",
    )
    parser.add_argument(
        "--event-type",
        choices=("entry", "exit"),
        default=os.environ.get("TRUE_EYE_CAMERA_EVENT_TYPE", "entry"),
        help="Whether the camera watches the classroom entrance or exit.",
    )
    parser.add_argument(
        "--event-code",
        choices=(0, 1),
        type=int,
        help="Numeric direction code: 1 for entry, 0 for exit. Overrides --event-type.",
    )
    parser.add_argument(
        "--db-path",
        default=os.environ.get("TRUE_EYE_DB", str(PROJECT_ROOT / "attendance.db")),
        help="Shared SQLite database path (default: TRUE_EYE_DB or attendance.db).",
    )
    parser.add_argument(
        "--late-grace-minutes",
        type=int,
        default=int(os.environ.get("TRUE_EYE_LATE_GRACE_MINUTES", "10")),
    )
    parser.add_argument(
        "--early-exit-review-minutes",
        type=int,
        default=int(os.environ.get("TRUE_EYE_EARLY_EXIT_REVIEW_MINUTES", "5")),
    )
    parser.add_argument("--sample-interval", type=float, default=0.5,
                        help="Seconds between recognition samples.")
    parser.add_argument("--confirm-hits", type=int, default=2,
                        help="Sampled matches within the confirmation window needed to accept an event.")
    parser.add_argument("--confirm-window", type=float, default=5.0,
                        help="Seconds allowed between confirmation samples.")
    parser.add_argument("--reconnect-delay", type=float, default=2.0)
    parser.add_argument(
        "--match-threshold",
        type=float,
        default=float(os.environ.get("TRUE_EYE_FACE_MATCH_THRESHOLD", "0.363")),
    )
    parser.add_argument("--headless", action="store_true",
                        help="Disable the preview window for a service or headless host.")
    args = parser.parse_args()
    if args.event_code is not None:
        args.event_type = "entry" if args.event_code == 1 else "exit"
    if not args.section_id.strip():
        parser.error("set --section-id or TRUE_EYE_CAMERA_SECTION")
    if not args.camera_id.strip():
        parser.error("--camera-id cannot be empty")
    if args.late_grace_minutes < 0 or args.early_exit_review_minutes < 0:
        parser.error("grace periods cannot be negative")
    if args.sample_interval <= 0 or args.confirm_window <= 0 or args.reconnect_delay <= 0:
        parser.error("sampling, confirmation, and reconnect intervals must be positive")
    if args.confirm_hits < 1:
        parser.error("--confirm-hits must be at least 1")
    if not 0 <= args.match_threshold <= 1:
        parser.error("--match-threshold must be between 0 and 1")
    args.source = parse_source(args.source)
    args.section_id = args.section_id.strip()
    args.camera_id = args.camera_id.strip()
    return args


def active_slot(section_id: str, event_type: str, now: datetime) -> dict | None:
    with api.connect() as db:
        slots = api.effective_section_schedule(db, section_id, now.date())
    current = now.replace(tzinfo=None)
    for slot in slots:
        start = datetime.combine(now.date(), time.fromisoformat(slot["startTime"]))
        end = datetime.combine(now.date(), time.fromisoformat(slot["endTime"]))
        if event_type == "exit":
            end += timedelta(minutes=5)
        if start <= current <= end:
            return slot
    return None


def load_registered_students(section_id: str) -> tuple[list, dict[str, str]]:
    with api.connect() as db:
        rows = db.execute("""SELECT s.student_id,s.name,s.embedding
            FROM students s JOIN student_profiles p ON p.student_id=s.student_id
            WHERE p.section_id=? AND p.enrollment_status='approved'
            ORDER BY s.student_id""", (section_id,)).fetchall()
        references = ref_store.load_all_references(db)

    names: dict[str, str] = {}
    match_rows = []
    for row in rows:
        vector = np.frombuffer(row["embedding"], dtype=np.float32)
        if vector.size == 0:
            continue
        names[row["student_id"]] = row["name"]
        match_rows.append(ref_store.as_match_rows(row["student_id"], row["name"], vector))
    for student_id, vector in references:
        if student_id in names:
            match_rows.append(ref_store.as_match_rows(student_id, names[student_id], vector))
    if not match_rows:
        raise RuntimeError("This section has no approved students with enrolled face data.")
    return match_rows, names


def open_source(source: int | str) -> cv2.VideoCapture:
    capture = cv2.VideoCapture(source, cv2.CAP_ANY)
    capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    return capture


def run() -> None:
    args = options()
    api.DB_PATH = Path(args.db_path).expanduser().resolve()
    api.init_db()

    if not YUNET_MODEL.is_file() or not SFACE_MODEL.is_file():
        raise FileNotFoundError("The YuNet and SFace model files are required in the models directory.")

    registered_students, names = load_registered_students(args.section_id)
    detector = cv2.FaceDetectorYN.create(
        str(YUNET_MODEL), "", (320, 320), 0.8, 0.3, 5000,
    )
    recognizer = cv2.FaceRecognizerSF.create(str(SFACE_MODEL), "")
    capture = open_source(args.source)
    if not capture.isOpened():
        print("Camera source is not open yet; the service will keep retrying.")

    print(f"Loaded {len(names)} approved face profile(s) for {args.section_id}.")
    print(f"Listening for {args.event_type} events from camera {args.camera_id}.")
    print("Unobserved students and early exits are sent for teacher review, not auto-marked absent.")
    if args.headless:
        print("Headless mode: stop with Ctrl+C.")
    else:
        print("Press Q in the preview window to stop.")

    candidate_hits: dict[str, int] = defaultdict(int)
    last_hit: dict[str, float] = {}
    recorded: set[tuple[str, str]] = set()
    current_slot_id: str | None = None
    last_heartbeat = 0.0
    next_sample = 0.0
    next_schedule_check = 0.0
    slot_cache: dict | None = None
    last_capture_failure = 0.0
    last_preview_at = 0.0
    harvest = ref_store.HarvestState()
    try:
        while True:
            now_monotonic = monotonic_time.monotonic()
            now = datetime.now().astimezone().replace(microsecond=0)
            if now_monotonic >= next_schedule_check:
                slot_cache = active_slot(args.section_id, args.event_type, now)
                next_schedule_check = now_monotonic + 1.0
            slot = slot_cache
            slot_key = slot["id"] if slot else None
            if slot_key != current_slot_id:
                candidate_hits.clear()
                last_hit.clear()
                current_slot_id = slot_key
                last_heartbeat = 0.0

            if slot is not None and now_monotonic - last_heartbeat >= 15:
                with api.connect() as db:
                    api.record_camera_run(
                        db, args.section_id, slot["id"], now.date(),
                        args.camera_id, args.event_type, now,
                    )
                last_heartbeat = now_monotonic

            success, frame = capture.read()
            if not success:
                if now_monotonic - last_capture_failure >= 10:
                    print("Camera feed unavailable; attendance will not be inferred from missing frames.")
                    last_capture_failure = now_monotonic
                capture.release()
                monotonic_time.sleep(args.reconnect_delay)
                capture = open_source(args.source)
                continue

            if slot is not None and now_monotonic >= next_sample:
                next_sample = now_monotonic + args.sample_interval
                height, width = frame.shape[:2]
                detector.setInputSize((width, height))
                _, faces = detector.detect(frame)
                hit_this_sample: dict[str, float] = {}
                if faces is not None:
                    for face in faces:
                        x, y, w, h = map(int, face[:4])
                        aligned = recognizer.alignCrop(frame, face)
                        vector = recognizer.feature(aligned)
                        score, student_id, name = ref_store.best_match(registered_students, vector)
                        recognized = score >= args.match_threshold and student_id is not None
                        # Exit camera labels the live detection as Absent for the
                        # operator. This is a visual cue only: exit events remain
                        # recorded as exits and do not rewrite attendance status.
                        color = ((0, 0, 255) if args.event_type == "exit" else (0, 255, 0)) if recognized else (0, 0, 255)
                        label = f"{name} ({student_id})" if recognized else "Unknown"
                        cv2.rectangle(frame, (x, y), (x + w, y + h), color, 2)
                        cv2.putText(frame, label, (x, max(y - 10, 25)),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.65, color, 2)
                        if recognized and args.event_type == "exit":
                            cv2.putText(frame, "Absent", (x, y + h + 22),
                                        cv2.FONT_HERSHEY_SIMPLEX, 0.65, color, 2)
                            score_y = y + h + 44
                        else:
                            score_y = y + h + 22
                        cv2.putText(frame, f"Score: {score:.3f}", (x, score_y),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
                        if not recognized:
                            continue

                        hit_this_sample[student_id] = float(score)
                        with api.connect() as db:
                            action, _ = harvest.maybe_store(db, student_id, vector, score)
                            # Harvesting is optional; attendance evidence is saved independently.
                            if action:
                                registered_students = [
                                    row for row in registered_students if row[0] != student_id
                                ]
                                primary = db.execute(
                                    "SELECT embedding FROM students WHERE student_id=?",
                                    (student_id,),
                                ).fetchone()
                                if primary and primary["embedding"]:
                                    registered_students.append(ref_store.as_match_rows(
                                        student_id, name,
                                        np.frombuffer(primary["embedding"], dtype=np.float32),
                                    ))
                                for reference in ref_store.load_student_references(db, student_id):
                                    registered_students.append(
                                        ref_store.as_match_rows(student_id, name, reference)
                                    )

                for student_id, event_score in hit_this_sample.items():
                    previous = last_hit.get(student_id)
                    if previous is None or now_monotonic - previous > args.confirm_window:
                        candidate_hits[student_id] = 1
                    else:
                        candidate_hits[student_id] += 1
                    last_hit[student_id] = now_monotonic
                    event_key = (slot["id"], student_id)
                    if candidate_hits[student_id] < args.confirm_hits or event_key in recorded:
                        continue
                    with api.connect() as db:
                        accepted = api.record_camera_attendance_event(
                            db, args.section_id, slot, now.date(), student_id,
                            args.camera_id, args.event_type, now, min(max(event_score, 0.0), 1.0),
                            args.late_grace_minutes, args.early_exit_review_minutes,
                        )
                    recorded.add(event_key)
                    if accepted:
                        print(
                            f"CAMERA {args.event_type.upper()}: {names[student_id]} "
                            f"({student_id}) at {now.strftime('%H:%M:%S')} "
                            f"[score {event_score:.3f}]"
                        )

                for student_id in list(last_hit):
                    if now_monotonic - last_hit[student_id] > args.confirm_window:
                        last_hit.pop(student_id, None)
                        candidate_hits.pop(student_id, None)

            preview_url = os.environ.get("TRUE_EYE_PREVIEW_URL", "").strip()
            preview_key = os.environ.get("TRUE_EYE_PREVIEW_KEY", "").strip()
            if preview_url and preview_key and now_monotonic - last_preview_at >= 0.25:
                encoded_ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
                if encoded_ok:
                    request = urllib.request.Request(
                        preview_url,
                        data=encoded.tobytes(),
                        headers={"Content-Type": "image/jpeg", "X-Preview-Key": preview_key},
                        method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request, timeout=0.35):
                            pass
                    except (urllib.error.URLError, TimeoutError):
                        pass
                last_preview_at = now_monotonic

            if not args.headless:
                cv2.imshow("True Eye - Timetable Camera", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
    except KeyboardInterrupt:
        print("Camera capture stopped.")
    finally:
        capture.release()
        if not args.headless:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    run()
