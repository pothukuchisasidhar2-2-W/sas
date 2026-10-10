import cv2
import sqlite3
import numpy as np
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
YUNET_MODEL = str(PROJECT_ROOT / "models" / "face_detection_yunet_2026may.onnx")
SFACE_MODEL = str(PROJECT_ROOT / "models" / "face_recognition_sface_2021dec.onnx")
DB_PATH = str(PROJECT_ROOT / "attendance.db")

# -----------------------------
# Student details
# -----------------------------
student_id = input("Enter Student ID: ").strip()
name = input("Enter Student Name: ").strip()

if not student_id or not name:
    print("Student ID and Name are required.")
    exit()

# -----------------------------
# Load models
# -----------------------------
detector = cv2.FaceDetectorYN.create(
    YUNET_MODEL,
    "",
    (320, 320),
    0.8,
    0.3,
    5000
)

recognizer = cv2.FaceRecognizerSF.create(
    SFACE_MODEL,
    ""
)

# -----------------------------
# Open camera
# -----------------------------
camera = cv2.VideoCapture(0)

if not camera.isOpened():
    print("Camera could not open.")
    exit()

print()
print("==============================")
print("STUDENT REGISTRATION")
print("==============================")
print("Look directly at the camera.")
print()
print("Press S OR SPACEBAR to register.")
print("Press Q to cancel.")
print("==============================")

face_detected = False
selected_face = None

while True:

    success, frame = camera.read()

    if not success:
        print("Could not read camera.")
        break

    height, width = frame.shape[:2]

    detector.setInputSize((width, height))

    _, faces = detector.detect(frame)

    face_detected = False
    selected_face = None

    # -----------------------------
    # Detect face
    # -----------------------------
    if faces is not None and len(faces) > 0:

        # Select largest face
        selected_face = max(
            faces,
            key=lambda f: f[2] * f[3]
        )

        x, y, w, h = map(
            int,
            selected_face[:4]
        )

        face_detected = True

        # Red rectangle
        cv2.rectangle(
            frame,
            (x, y),
            (x + w, y + h),
            (0, 0, 255),
            2
        )

        cv2.putText(
            frame,
            "Face detected",
            (x, max(y - 10, 25)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (0, 0, 255),
            2
        )

    else:

        cv2.putText(
            frame,
            "No face detected",
            (30, 40),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (0, 0, 255),
            2
        )

    # -----------------------------
    # Instructions on screen
    # -----------------------------
    cv2.putText(
        frame,
        "Press S or SPACE to register",
        (30, height - 50),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.7,
        (255, 255, 255),
        2
    )

    cv2.putText(
        frame,
        "Press Q to cancel",
        (30, height - 20),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.6,
        (255, 255, 255),
        2
    )

    # -----------------------------
    # Show camera
    # -----------------------------
    cv2.imshow(
        "Student Registration",
        frame
    )

    # -----------------------------
    # Read keyboard
    # -----------------------------
    key = cv2.waitKey(1) & 0xFF

    # S key OR Spacebar
    if key == ord("s") or key == ord("S") or key == 32:

        if not face_detected:
            print("No face detected. Look at the camera and try again.")
            continue

        print()
        print("Face captured!")
        print("Generating face embedding...")

        try:

            aligned_face = recognizer.alignCrop(
                frame,
                selected_face
            )

            embedding = recognizer.feature(
                aligned_face
            )

        except Exception as e:

            print("Could not generate embedding.")
            print("Error:", e)
            continue

        if embedding is None:
            print("Embedding generation failed.")
            continue

        print(
            "Embedding shape:",
            embedding.shape
        )

        # -----------------------------
        # Save embedding
        # -----------------------------
        embedding_bytes = (
            embedding
            .astype(np.float32)
            .tobytes()
        )

        connection = sqlite3.connect(
            DB_PATH
        )

        cursor = connection.cursor()

        cursor.execute(
            """
            INSERT OR REPLACE INTO students
            (student_id, name, embedding)
            VALUES (?, ?, ?)
            """,
            (
                student_id,
                name,
                embedding_bytes
            )
        )

        connection.commit()
        connection.close()

        print()
        print("==============================")
        print("REGISTRATION SUCCESSFUL")
        print("==============================")
        print("Student ID :", student_id)
        print("Name       :", name)
        print("Embedding  : Stored")
        print("==============================")

        # Small delay so user can see success
        time.sleep(2)

        break

    # -----------------------------
    # Quit
    # -----------------------------
    if key == ord("q") or key == ord("Q"):

        print("Registration cancelled.")
        break


camera.release()
cv2.destroyAllWindows()