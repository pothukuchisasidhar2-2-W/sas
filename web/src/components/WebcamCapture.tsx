/* ---------------------------------------------------------------------------
   Single-frame webcam capture.

   This deliberately captures ONE still and hands back a JPEG data URL — it does
   not stream anywhere. The server extracts the embedding from that frame using
   the same YuNet + SFace models as register.py, so the stored vector is
   identical in shape and normalisation to a desktop enrolment.

   getUserMedia only works in a secure context: https, or localhost during
   development. That constraint is surfaced explicitly rather than letting the
   button fail silently.
--------------------------------------------------------------------------- */

import { useCallback, useEffect, useRef, useState } from "react";

import { Alert, Button, cx } from "./ui";

type Phase = "idle" | "starting" | "live" | "captured" | "error";

export function WebcamCapture({
  onCapture,
  onRetake,
  capturedImage,
  disabled,
}: {
  /** Called with a `data:image/jpeg;base64,...` string. */
  onCapture: (dataUrl: string) => void;
  onRetake?: () => void;
  /** Show an already-captured frame instead of the live feed. */
  capturedImage?: string | null;
  disabled?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(capturedImage ?? null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setPhase((current) => (current === "error" ? current : "idle"));
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    setError(null);
    setPhase("starting");

    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase("error");
      setError(
        "This browser has no camera API. Use a modern browser over https or on localhost.",
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setPhase("live");
    } catch (cause) {
      setPhase("error");
      const name = cause instanceof DOMException ? cause.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError(
          "Camera access was blocked. Allow the camera for this site in your browser's address bar, then try again.",
        );
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setError("No camera was found on this device.");
      } else if (name === "NotReadableError") {
        setError(
          "The camera is already in use — close register.py or any other app holding it, then try again.",
        );
      } else {
        setError("The camera could not be started. Check it is not in use by another app.");
      }
    }
  }, []);

  const capture = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    setPreview(dataUrl);
    setPhase("captured");
    stop();
    onCapture(dataUrl);
  }, [onCapture, stop]);

  const retake = useCallback(() => {
    setPreview(null);
    onRetake?.();
    void start();
  }, [onRetake, start]);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative aspect-[4/3] overflow-hidden rounded-card border border-line bg-ink/90">
        {/* Live feed */}
        <video
          ref={videoRef}
          playsInline
          muted
          className={cx("size-full object-cover", phase === "live" ? "opacity-100" : "opacity-0")}
        />

        {/* Captured still */}
        {preview && phase === "captured" && (
          <img src={preview} alt="Captured enrolment frame" className="absolute inset-0 size-full object-cover" />
        )}

        {/* Framing guide */}
        {phase === "live" && (
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute left-1/2 top-1/2 h-[62%] w-[42%] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border-2 border-white/70" />
            <p className="absolute inset-x-0 bottom-3 text-center text-xs text-white/85">
              Keep your whole face inside the oval, then capture.
            </p>
          </div>
        )}

        {/* Placeholder / error states */}
        {phase !== "live" && !preview && (
          <div className="absolute inset-0 grid place-items-center px-6 text-center">
            <p className="text-xs text-white/70">
              {phase === "starting" ? "Starting the camera…" : "The camera is off."}
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {phase === "captured" ? (
          <Button variant="secondary" onClick={retake} disabled={disabled}>
            Retake photo
          </Button>
        ) : phase === "live" ? (
          <>
            <Button onClick={capture} disabled={disabled}>
              Capture photo
            </Button>
            <Button variant="ghost" onClick={stop}>
              Turn camera off
            </Button>
          </>
        ) : (
          <Button onClick={start} loading={phase === "starting"} disabled={disabled}>
            Turn camera on
          </Button>
        )}
      </div>

      {error && (
        <Alert tone="error" title="Camera unavailable">
          {error}
        </Alert>
      )}
    </div>
  );
}
