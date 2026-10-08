import cv2

# ==========================================
# SMART ATTENDANCE - FACE DETECTION
# ==========================================

MODEL_PATH = "models/face_detection_yunet_2026may.onnx"

# ------------------------------------------
# Open webcam
# ------------------------------------------

camera = cv2.VideoCapture(0)

if not camera.isOpened():
    print("ERROR: Camera could not be opened.")
    exit()

# Get camera resolution
width = int(camera.get(cv2.CAP_PROP_FRAME_WIDTH))
height = int(camera.get(cv2.CAP_PROP_FRAME_HEIGHT))

print(f"Camera resolution: {width} x {height}")

# ------------------------------------------
# Create YuNet face detector
# ------------------------------------------

detector = cv2.FaceDetectorYN.create(
    MODEL_PATH,
    "",
    (width, height),
    0.9,
    0.3,
    5000
)

print("Face detection started.")
print("Press Q to quit.")

# ------------------------------------------
# Main camera loop
# ------------------------------------------

while True:

    # Read webcam frame
    success, frame = camera.read()

    if not success:
        print("Could not read camera frame.")
        break

    # Tell detector current frame size
    detector.setInputSize(
        (frame.shape[1], frame.shape[0])
    )

    # Detect faces
    _, faces = detector.detect(frame)

    # --------------------------------------
    # Draw rectangle around every face
    # --------------------------------------

    if faces is not None:

        for face in faces:

            # Face bounding box
            x = int(face[0])
            y = int(face[1])
            w = int(face[2])
            h = int(face[3])

            # Confidence
            confidence = face[-1]

            # RED rectangle
            cv2.rectangle(
                frame,
                (x, y),
                (x + w, y + h),
                (0, 0, 255),
                2
            )

            # Show confidence
            cv2.putText(
                frame,
                f"Face {confidence:.2f}",
                (x, max(y - 10, 20)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (0, 0, 255),
                2
            )

    # --------------------------------------
    # Show camera
    # --------------------------------------

    cv2.imshow(
        "Smart Attendance - Face Detection",
        frame
    )

    # Press Q to quit
    if cv2.waitKey(1) & 0xFF == ord("q"):
        break


# ------------------------------------------
# Cleanup
# ------------------------------------------

camera.release()
cv2.destroyAllWindows()

print("Camera closed.")