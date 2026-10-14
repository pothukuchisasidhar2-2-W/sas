
import cv2
import sqlite3
import numpy as np
from pathlib import Path

# ==========================================
# CONFIGURATION
# ==========================================
BASE_DIR = Path(__file__).resolve().parent

YUNET_MODEL = str(
    BASE_DIR / "models" / "face_detection_yunet_2026may.onnx"
)
SFACE_MODEL = str(
    BASE_DIR / "models" / "face_recognition_sface_2021dec.onnx"
)
DB_PATH = str(BASE_DIR / "attendance.db")


def main():
    # Check model files
    if not Path(YUNET_MODEL).is_file():
        print("ERROR: YuNet model not found:", YUNET_MODEL)
        return

    if not Path(SFACE_MODEL).is_file():
        print("ERROR: SFace model not found:", SFACE_MODEL)
        return

    # Get student details
    student_id = input("Enter Student ID: ").strip()
    name = input("Enter Student Name: ").strip()

    if not student_id or not name:
        print("Student ID and name are required.")
        return

    # Load face detection model
    detector = cv2.FaceDetectorYN.create(
        YUNET_MODEL,
        "",
        (320, 320),
        0.8,
        0.3,
        5000
    )

    # Load face recognition model
    recognizer = cv2.FaceRecognizerSF.create(
        SFACE_MODEL,
        ""
    )

    # Open camera
    camera = cv2.VideoCapture(0)

    if not camera.isOpened():
        print("ERROR: Could not open camera.")
        return

    window_name = "Student Registration"

    print("\n================================")
    print("STUDENT FACE REGISTRATION")
    print("================================")
    print("1. Look directly at the camera.")
    print("2. Click inside the camera window.")
    print("3. Press SPACE or S to register.")
    print("4. Press Q or ESC to cancel.")
    print("================================\n")

    # Create and focus the camera window
    cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)

    embedding_to_save = None

    try:
        while True:
            success, frame = camera.read()

            if not success:
                print("ERROR: Could not read camera.")
                break

            height, width = frame.shape[:2]
            detector.setInputSize((width, height))

            _, faces = detector.detect(frame)

            selected_face = None

            if faces is not None and len(faces) > 0:
                # Use the largest detected face
                selected_face = max(
                    faces,
                    key=lambda f: f[2] * f[3]
                )

                x, y, w, h = map(
                    int, selected_face[:4]
                )

                cv2.rectangle(
                    frame,
                    (x, y),
                    (x + w, y + h),
                    (0, 0, 255),
                    2
                )

                message = "Face detected - SPACE / S to save"
                color = (0, 0, 255)

            else:
                message = "No face detected"
                color = (0, 0, 255)

            cv2.putText(
                frame,
                message,
                (20, 35),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.65,
                color,
                2
            )

            cv2.putText(
                frame,
                "Q / ESC: Cancel",
                (20, height - 20),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (255, 255, 255),
                2
            )

            cv2.imshow(window_name, frame)

            # waitKeyEx can capture extended keyboard codes.
            # A longer wait also gives the window time to process events.
            key = cv2.waitKeyEx(20)

            # Normalize common key codes
            if key != -1:
                key_low = key & 0xFF
            else:
                key_low = -1

            # SPACE, S, or s
            if key_low in (32, ord("s"), ord("S")):
                print("Capture key received.")

                if selected_face is None:
                    print("No face detected. Please try again.")
                    continue

                try:
                    # Use the original frame and matching face data
                    aligned_face = recognizer.alignCrop(
                        frame,
                        selected_face
                    )

                    embedding = recognizer.feature(
                        aligned_face
                    )

                    if embedding is None or embedding.size == 0:
                        print("Could not generate embedding. Try again.")
                        continue

                    embedding = np.asarray(
                        embedding,
                        dtype=np.float32
                    ).reshape(1, -1)

                    embedding_to_save = embedding.tobytes()

                    print("Face embedding generated successfully.")
                    break

                except cv2.error as error:
                    print("Face processing failed:", error)
                    print("Adjust your position and try again.")

            # Q or ESC
            elif key_low in (ord("q"), ord("Q"), 27):
                print("Registration cancelled.")
                return

    finally:
        camera.release()
        cv2.destroyAllWindows()

    if embedding_to_save is None:
        print("Registration was not completed.")
        return

    # Save the student's embedding
    try:
        with sqlite3.connect(DB_PATH) as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO students
                (student_id, name, embedding)
                VALUES (?, ?, ?)
                """,
                (student_id, name, embedding_to_save)
            )

        print("\n================================")
        print("REGISTRATION SUCCESSFUL")
        print("Student ID:", student_id)
        print("Name:", name)
        print("Face embedding saved to attendance.db")
        print("================================")

    except sqlite3.Error as error:
        print("Database error:", error)


if __name__ == "__main__":
    main()
