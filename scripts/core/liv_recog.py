import cv2
import sqlite3
import numpy as np
from datetime import datetime

YUNET_MODEL = "models/face_detection_yunet_2026may.onnx"
SFACE_MODEL = "models/face_recognition_sface_2021dec.onnx"
DB_PATH = "attendance.db"


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


# -----------------------------
# Load students from database
# -----------------------------
connection = sqlite3.connect(DB_PATH)
cursor = connection.cursor()

cursor.execute("""
    SELECT student_id, name, embedding
    FROM students
""")

students = cursor.fetchall()

connection.close()


if not students:
    print("No registered students found!")
    exit()


registered_students = []

for student_id, name, embedding_bytes in students:

    embedding = np.frombuffer(
        embedding_bytes,
        dtype=np.float32
    ).reshape(1, -1)

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
    exit()


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
            if best_score >= 0.363:

                student_id, name = best_student

                label = f"{name} ({student_id})"

                box_color = (0, 255, 0)


                # -----------------------------
                # Mark Attendance
                # -----------------------------
                now = datetime.now()

                today = now.strftime("%Y-%m-%d")
                current_time = now.strftime("%H:%M:%S")


                connection = sqlite3.connect(DB_PATH)
                cursor = connection.cursor()


                cursor.execute("""
                    SELECT id
                    FROM attendance
                    WHERE student_id = ?
                    AND date = ?
                """, (
                    student_id,
                    today
                ))


                existing_record = cursor.fetchone()


                if existing_record is None:

                    cursor.execute("""
                        INSERT INTO attendance
                        (student_id, date, in_time, out_time)
                        VALUES (?, ?, ?, NULL)
                    """, (
                        student_id,
                        today,
                        current_time
                    ))

                    connection.commit()

                    print(
                        f"ATTENDANCE MARKED: "
                        f"{name} ({student_id}) "
                        f"IN at {current_time}"
                    )


                connection.close()


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


camera.release()
cv2.destroyAllWindows()

print("Attendance system stopped.")