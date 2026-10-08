import cv2

camera = cv2.VideoCapture(0)

camera.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)

if not camera.isOpened():
    print("Camera could not be opened")
    exit()

width = int(camera.get(cv2.CAP_PROP_FRAME_WIDTH))
height = int(camera.get(cv2.CAP_PROP_FRAME_HEIGHT))

print(f"Camera resolution: {width} x {height}")

while True:
    success, frame = camera.read()

    if not success:
        break

    cv2.imshow("Smart Attendance Camera", frame)

    if cv2.waitKey(1) & 0xFF == ord("q"):
        break

camera.release()
cv2.destroyAllWindows()