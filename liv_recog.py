import cv2
import sqlite3
import numpy as np
from datetime import datetime

YUNET_MODEL = "models/face_detection_yunet_2026may.onnx"
SFACE_MODEL = "models/face_recognition_sface_2021dec.onnx"
DB_PATH = "attendance.db"



# ---------------------------------------------------------------------------
# Match settings
# ---------------------------------------------------------------------------
MATCH_THRESHOLD = 0.363            # cosine-score threshold for a 'recognized' face
# Update this only alongside any server-side retraining; do NOT raise it
# speculation without looking at real unseen faces. The first convincing
# hard case should drive the change, not a single live demo.



# -----------------------------
# Face Detector
# -----------------------------
detector = cv2.FaceDetectorYN.create(
    YUNET_MODEL,
    "",
    (320, 320),
    0.8,
    0.3,
    5000
)



# -----------------------------
# Face Recognizer
# -----------------------------
recognizer = cv2.FaceRecognizerSF.create(
    SFACE_MODEL,
    ""
)



# ---------------------------------------------------------------------------
# Sharing SQLite across threads/processes is the #1 source of weird sqlite3
# errors on these machines, including the multisetbuffer message browsers
# surface when several clients write at once. Keep the DB tidy with WAL mode
# and a busy timeout so a slow writer does not hard-fail the recognizer.
# ---------------------------------------------------------------------------
def open_db():
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn



# ---------------------------------------------------------------------------
# Initial database setup. The legacy schema only keyed attendance by
# student_id + date, which lets two concurrent runs or a re-run mark the
# same person twice. We add a uniqueness constraint, but because SQLite
# cannot ALTER a table into a UNIQUE constraint easily, the constraint is
# first enforced at the application layer here. The staging site should
# `database.py` IS the source of truth for schema migrations.
# ---------------------------------------------------------------------------
def _ensure_attendance_uniqueness_constraint(conn):
    """If a UNIQUE constraint is missing on (student_id, date), add a
    runtime guard so duplicate inserts do not happen. The persisted schema
    should be migrated properly through database.py, but until that is wired
    into every entry point, this prevents the most common duplicate case.
    """
    cur = conn.cursor()
    cur.execute("PRAGMA table_info(attendance)")
    present = {row[1] for row in cur.fetchall()}

    if not ({"student_id", "date"} <= present):
        return

    # Detecting the exact absence of a unique index in SQLite is best done
    # by querying sqlite_master, not by guessing names.
    cur.execute("""
        SELECT 1 FROM sqlite_master
        WHERE type='index' AND name='attendance_student_date_unique'
        LIMIT 1
    """)
    if cur.fetchone() is not None:
        return

    connection = conn
    cur = conn.cursor()
    try:
        cur.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS
            attendance_student_date_unique
            ON attendance(student_id, date)
        """)
    except sqlite3.OperationalError:
        # SQLite will raise if the raw DB file does not allow unique
        # indexes on the existing rows; ignore here and rely on the
        # app-layer guard in the main loop.
        pass



# -----------------------------
# Load students from database
# -----------------------------



connection = open_db()
cursor = connection.cursor()

# SQLite journal mode is set inside open_db(); read it back for the log.
cursor.execute("PRAGMA journal_mode=WAL")
print("SQLite journal mode:", cursor.fetchone()[0])

_ensure_attendance_uniqueness_constraint(connection)

cursor.execute("""
    SELECT student_id, name, embedding
    FROM students
""")

students = cursor.fetchall()

if not students:
    print("No registered students found!")
    raise SystemExit()



registered_students = []

for student_id, name, embedding_bytes in students:

    embedding = np.frombuffer(
        embedding_bytes,
        dtype=np.float32
    ).reshape(1, -1)

    # Server-side and recognition-time matching both normalize before
    # cosine comparison, so normalize once here as well for consistency.
    norm = float(np.linalg.norm(embedding, ord=2))
    if norm > 0:
        embedding = embedding / norm
    registered_students.append(
        (student_id, name, embedding)
    )



print(f"{len(registered_students)} student(s) loaded.")
print("Starting live recognition...")
print("Attendance system active.")
print("Press Q to quit.")



# -----------------------------
# Camera
# -----------------------------
camera = cv2.VideoCapture(0)

if not camera.isOpened():
    print("Camera could not open.")
    raise SystemExit()



# ---------------------------------------------------------------------------
# Track per-student state across the live loop so a single correctly matched
# frame does not immediately re-insert a row that already exists. This holds
# until the next explicit restart of the session; on the real backend, this
# role is played by the session model and per-session upsert.
# ---------------------------------------------------------------------------
marked_today = set()



# -----------------------------
# Live Recognition
# -----------------------------
while True:

    success, frame = camera.read()

    if not success:
        print("Could not read camera.")
        break



    height, width = frame.shape[:2]

    detector.setInputSize((width, height))

    _, faces = detector.detect(frame)



    if faces is not None:

        for face in faces:

            x, y, w, h = map(int, face[:4])



            # -----------------------------
            # Generate live embedding
            # -----------------------------
            aligned_face = recognizer.alignCrop(
                frame,
                face
            )

            live_embedding = recognizer.feature(
                aligned_face
            )



            # -----------------------------
            # Find best student
            # -----------------------------
            best_student = None
            best_score = -1



            for student_id, name, registered_embedding in registered_students:

                score = recognizer.match(
                    live_embedding,
                    registered_embedding,
                    cv2.FaceRecognizerSF_FR_COSINE
                )

                if score > best_score:

                    best_score = score

                    best_student = (
                        student_id,
                        name
                    )



            # -----------------------------
            # Recognized
            # -----------------------------
            if best_score >= MATCH_THRESHOLD:

                student_id, name = best_student

                label = f"{name} ({student_id})"

                box_color = (0, 255, 0)



                # -----------------------------
                # Mark Attendance
                # -----------------------------
                now = datetime.now()

                today = now.strftime("%Y-%m-%d")
                current_time = now.strftime("%H:%M:%S")



                # Only insert if we have not already marked today for this
                # student in this run of the process. Persisted uniqueness
                # is enforced by the schema constraint that `database.py`
                # will create on the next schema update.
                if student_id in marked_today:
                    continue

                cursor = connection.cursor()

                # Application-layer uniqueness guard in case the index was
                # not created (e.g. legacy DB without the migration). When
                # this guard or the index is both active, cancellation of a
                # duplicate insert is handled by the index / UniqueError.
                existing = cursor.execute(
                    """
                        SELECT 1 FROM attendance
                        WHERE student_id = ? AND date = ?
                        LIMIT 1
                    """,
                    (student_id, today),
                ).fetchone()

                if existing:
                    marked_today.add(student_id)
                    continue

                cursor.execute(
                    """
                        INSERT INTO attendance
                        (student_id, date, in_time, out_time)
                        VALUES (?, ?, ?, NULL)
                    """,
                    (student_id, today, current_time),
                )

                connection.commit()

                marked_today.add(student_id)

                print(
                    f"ATTENDANCE MARKED: "
                    f"{name} ({student_id}) "
                    f"IN at {current_time}"
                )



            # -----------------------------
            # Unknown
            # -----------------------------
            else:

                label = "Unknown"

                box_color = (0, 0, 255)



            # -----------------------------
            # Draw rectangle
            # -----------------------------
            cv2.rectangle(
                frame,
                (x, y),
                (x + w, y + h),
                box_color,
                2
            )



            # -----------------------------
            # Name / ID
            # -----------------------------
            cv2.putText(
                frame,
                label,
                (x, max(y - 10, 25)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.7,
                box_color,
                2
            )



            # -----------------------------
            # Score
            # -----------------------------
            cv2.putText(
                frame,
                f"Score: {best_score:.3f}",
                (x, y + h + 25),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                box_color,
                2
            )



    # -----------------------------
    # Show camera
    # -----------------------------
    cv2.imshow(
        "Smart Attendance - Live Recognition",
        frame
    )



    # -----------------------------
    # Quit
    # -----------------------------
    if cv2.waitKey(1) & 0xFF == ord("q"):
        break



# Do not leave a SQLite connection open when the process exits.
connection.close()

camera.release()
cv2.destroyAllWindows()

print("Attendance system stopped.")