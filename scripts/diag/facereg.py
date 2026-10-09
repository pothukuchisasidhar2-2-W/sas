
import cv2

YUNET_MODEL = "models/face_detection_yunet_2026may.onnx"
SFACE_MODEL = "models/face_recognition_sface_2021dec.onnx"

# Load both AI models
detector = cv2.FaceDetectorYN.create(
    YUNET_MODEL, "", (320, 320), 0.8, 0.3, 5000
)

recognizer = cv2.FaceRecognizerSF.create(
    SFACE_MODEL, ""
)

# Open webcam
camera = cv2.VideoCapture(0)

if not camera.isOpened():
    print("Camera could not open!")
    raise SystemExit

print("Camera started. Press Q to quit.")

while True:
    success, frame = camera.read()

    if not success:
        print("Could not read camera frame.")
        break

    height, width = frame.shape[:2]
    detector.setInputSize((width, height))

    _, faces = detector.detect(frame)

    if faces is not None:
        for face in faces:
            x, y, w, h = map(int, face[:4])

            # Draw red rectangle around face
            cv2.rectangle(
                frame, (x, y), (x + w, y + h), (0, 0, 255), 2
            )

            # Align and crop face for SFace
            aligned_face = recognizer.alignCrop(frame, face)

            # Generate live numeric embedding
            embedding = recognizer.feature(aligned_face)

            # Display a shortened embedding on screen
            numbers = ", ".join(
                f"{v:.3f}" for v in embedding.flatten()[:5]
            )

            cv2.putText(
                frame,
                "Embedding generated!",
                (x, max(y - 30, 25)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (0, 255, 0),
                2
            )

            print("Live embedding:", embedding.shape)
            print("First 5 values:", numbers)

    cv2.imshow("Smart Attendance - Live Embedding", frame)

    if cv2.waitKey(1) & 0xFF == ord("q"):
        break

camera.release()
cv2.destroyAllWindows()