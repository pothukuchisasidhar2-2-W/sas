import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { api, errorMessage } from "../../api/client";
import { PageBody, PageHeader } from "../../components/AppShell";
import { WebcamCapture } from "../../components/WebcamCapture";
import { Alert, Badge, Button, Card, CardBody, CardHeader, KeyValue } from "../../components/ui";
import { useAuth, useToken } from "../../lib/auth";

/**
 * Face enrolment.
 *
 * This is the browser equivalent of running `register.py`, with one difference
 * worth being explicit about: the photo never leaves as an image. It is posted
 * to the API, which extracts the embedding with the same YuNet + SFace models
 * and stores only the vector — exactly what `students.embedding` already holds.
 */
export default function StudentEnroll() {
  const { user, refresh } = useAuth();
  const token = useToken();
  const navigate = useNavigate();

  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (!user || user.role !== "student") return null;
  const student = user.profile;

  const submit = async () => {
    if (!image) {
      setError("Capture a photo first.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await api.enrollFace(token, image);
      await refresh();
      setDone(true);
      navigate("/student", { replace: true });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageBody>
      <PageHeader
        title={student.faceEnrolled ? "Re-enrol your face" : "Enrol your face"}
        description={
          student.faceEnrolled
            ? "You already have a stored embedding. Capturing again replaces it and clears any extra views the camera had learned."
            : "One clear photo is all the recogniser needs. It runs entirely on this network — the image is never stored, only the resulting numbers."
        }
        actions={<Badge tone={student.faceEnrolled ? "present" : "late"}>
          {student.faceEnrolled ? "Enrolled" : "Not enrolled"}
        </Badge>}
      />

      {done && (
        <div className="pb-4">
          <Alert tone="success" title="Face enrolled">
            Your embedding was stored. The camera can now recognise you during class.
          </Alert>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* Capture */}
        <Card>
          <CardHeader
            title="Camera"
            description="Face the camera in even light, keep your whole face inside the oval, then capture."
          />
          <CardBody>
            <WebcamCapture
              capturedImage={image}
              onCapture={(dataUrl) => {
                setImage(dataUrl);
                setError(null);
              }}
              onRetake={() => setImage(null)}
              disabled={busy}
            />
          </CardBody>
        </Card>

        {/* Verification + actions */}
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader
              title="Check your details"
              description="These are the details the camera will file attendance under."
            />
            <CardBody>
              <dl className="flex flex-col gap-1">
                <KeyValue label="Name" value={student.name} />
                <KeyValue label="Roll number" value={student.studentId} />
                <KeyValue label="Branch" value={student.branch} />
                <KeyValue label="Year" value={student.year} />
                <KeyValue label="Section" value={student.section} />
                <KeyValue label="Class" value={student.sectionId} />
              </dl>
              <p className="mt-3 text-xs leading-relaxed text-muted">
                Wrong details? Fix them in your profile before enrolling — attendance is keyed on
                the roll number.
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardBody className="flex flex-col gap-3">
              {error && <Alert tone="error">{error}</Alert>}
              <Button onClick={submit} loading={busy} disabled={!image} className="w-full">
                {student.faceEnrolled ? "Replace my embedding" : "Save my face"}
              </Button>
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => navigate("/student")}
                disabled={busy}
              >
                Skip for now
              </Button>
              <p className="text-xs leading-relaxed text-muted">
                Skipping is fine — you can enrol from your profile at any time, but the camera
                cannot mark you present until you do.
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </PageBody>
  );
}
