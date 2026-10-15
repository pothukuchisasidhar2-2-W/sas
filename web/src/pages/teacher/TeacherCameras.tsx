import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api, createTeacherCameraPreviewUrl, listTeacherCameras, startTeacherCamera, stopTeacherCamera, teacherCameraStatus, USING_MOCK } from "../../api/client";
import type { SectionOption } from "../../api/contract";
import type { CameraDevice, RecognitionCameraRun } from "../../api/types";
import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, Select, Spinner } from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { isoToday } from "../../lib/format";

type CameraDirection = "entry" | "exit";

function useCameraPreviewUrl(camera: RecognitionCameraRun | null, token: string) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let active = true;
    setUrl("");
    if (!camera || !token || USING_MOCK) return () => { active = false; };
    createTeacherCameraPreviewUrl(camera.source)
      .then((nextUrl) => { if (active) setUrl(nextUrl); })
      .catch(() => { if (active) setUrl(""); });
    return () => { active = false; };
  }, [camera?.source, token]);
  return url;
}

export default function TeacherCameras() {
  const { session } = useAuth();
  const token = session?.token ?? "";
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [sections, setSections] = useState<SectionOption[]>([]);
  const [running, setRunning] = useState<RecognitionCameraRun[]>([]);
  const [sectionId, setSectionId] = useState("");
  const [entrySource, setEntrySource] = useState("");
  const [exitSource, setExitSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const visibleDevices = devices.filter((camera) => camera.cameraType === "usb" || camera.sectionId === sectionId);
  const entryRun = running.find((camera) => camera.eventType === "entry" && camera.sectionId === sectionId) ?? null;
  const exitRun = running.find((camera) => camera.eventType === "exit" && camera.sectionId === sectionId) ?? null;
  const otherRunning = running.filter((camera) =>
    camera.source !== entryRun?.source && camera.source !== exitRun?.source,
  );
  const entryPreviewUrl = useCameraPreviewUrl(entryRun, token);
  const exitPreviewUrl = useCameraPreviewUrl(exitRun, token);

  useEffect(() => {
    let cancelled = false;
    if (USING_MOCK || !token) {
      setLoading(false);
      setError("Camera controls require the live API. Set VITE_API_URL and run the API on the computer that can reach the cameras.");
      return;
    }

    Promise.all([listTeacherCameras(), api.teacherSections(token)])
      .then(([cameraResult, sectionResult]) => {
        if (cancelled) return;
        setDevices(cameraResult.devices);
        setRunning(cameraResult.running);
        setSections(sectionResult);
        const initialSection = sectionResult[0]?.id || "";
        setSectionId((current) => current || initialSection);
        const eligible = cameraResult.devices.filter((camera) => camera.cameraType === "usb" || camera.sectionId === initialSection);
        setEntrySource((current) => current || eligible[0]?.source || "");
        setExitSource((current) => current || eligible.find((camera) => camera.source !== eligible[0]?.source)?.source || "");
        setError("");
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load camera setup.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    const timer = window.setInterval(() => {
      teacherCameraStatus().then((result) => {
        if (!cancelled) setRunning(result.running);
      }).catch(() => undefined);
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [token]);

  const refreshCameras = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await listTeacherCameras();
      setDevices(result.devices);
      setRunning(result.running);
      const eligible = result.devices.filter((camera) => camera.cameraType === "usb" || camera.sectionId === sectionId);
      if (!eligible.some((camera) => camera.source === entrySource)) setEntrySource(eligible[0]?.source || "");
      if (!eligible.some((camera) => camera.source === exitSource)) {
        setExitSource(eligible.find((camera) => camera.source !== (eligible[0]?.source || ""))?.source || "");
      }
      setNotice(result.devices.length ? "Camera list refreshed." : "No cameras are configured or connected for your assigned classes.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not refresh cameras.");
    } finally {
      setBusy(false);
    }
  };

  const setSection = (nextSection: string) => {
    setSectionId(nextSection);
    const eligible = devices.filter((camera) => camera.cameraType === "usb" || camera.sectionId === nextSection);
    setEntrySource(eligible[0]?.source || "");
    setExitSource(eligible.find((camera) => camera.source !== (eligible[0]?.source || ""))?.source || "");
  };

  const startCamera = async (eventType: CameraDirection) => {
    const source = eventType === "entry" ? entrySource : exitSource;
    if (!source || !sectionId) return;
    if (running.some((camera) => camera.source === source)) {
      setError("A camera can run only one direction at a time. Choose another camera or stop its current session.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const run = await startTeacherCamera({ source, sectionId, eventType });
      setRunning((current) => [...current.filter((camera) => camera.source !== run.source), run]);
      setNotice(`${run.name} started as the ${eventType} camera.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not start the ${eventType} camera.`);
    } finally {
      setBusy(false);
    }
  };

  const stopCamera = async (camera: RecognitionCameraRun) => {
    setBusy(true);
    setError("");
    try {
      await stopTeacherCamera(camera.source);
      setRunning((current) => current.filter((item) => item.source !== camera.source));
      setNotice(`Recognition stopped on ${camera.name}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not stop camera recognition.");
    } finally {
      setBusy(false);
    }
  };

  const renderCameraSlot = (direction: CameraDirection, camera: RecognitionCameraRun | null, source: string, onSourceChange: (value: string) => void) => {
    const title = direction === "entry" ? "Entry camera" : "Exit camera";
    const previewUrl = direction === "entry" ? entryPreviewUrl : exitPreviewUrl;
    return (
      <Card>
        <CardHeader
          title={title}
          description={direction === "entry"
            ? "Recognized students are marked present or late when they enter during a scheduled period."
            : "Exit observations are checked against the scheduled period and sent for review when needed."}
          action={camera ? <Badge tone={direction === "entry" ? "present" : "brand"}>Running</Badge> : undefined}
        />
        <CardBody className="flex flex-col gap-4">
          <Field label="Select camera" required hint="USB cameras connect to the API computer. IP cameras are granted by the operator for this class.">
            <Select value={source} onChange={(event) => onSourceChange(event.target.value)} disabled={Boolean(camera) || busy || !visibleDevices.length}>
              {!visibleDevices.length && <option value="">No cameras available for this class</option>}
              {visibleDevices.map((device) => <option key={device.source} value={device.source}>{device.name} · {device.cameraType === "ip" ? "IP" : "USB"}</option>)}
            </Select>
          </Field>
          {camera ? (
            <>
              {previewUrl ? (
                <img src={previewUrl} alt={`Live annotated ${direction} camera footage from ${camera.name}`} className="aspect-video w-full rounded-field bg-black object-contain" />
              ) : (
                <div className="flex aspect-video items-center justify-center rounded-field bg-ink text-sm text-white"><Spinner className="mr-2 size-4" /> Connecting to {camera.name}…</div>
              )}
              <p className="text-xs text-muted">Live annotated feed from {camera.name}. Video is not saved.</p>
              <Button variant="danger" onClick={() => void stopCamera(camera)} loading={busy}>Stop {direction} camera</Button>
            </>
          ) : (
            <>
              <div className="flex aspect-video items-center justify-center rounded-field bg-canvas px-4 text-center text-sm text-muted">
                Start an {direction} camera to view its live annotated footage here.
              </div>
              <Button onClick={() => void startCamera(direction)} loading={busy} disabled={!source || !sectionId || running.some((item) => item.source === source)}>
                Start {direction} camera
              </Button>
            </>
          )}
        </CardBody>
      </Card>
    );
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand">Attendance devices</p>
        <h1 className="mt-2 text-2xl font-semibold text-ink">Camera setup</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">Choose separate Entry and Exit cameras and watch both live annotated feeds together. Attendance remains linked to this class’s timetable.</p>
      </div>

      {error && <div role="alert" className="rounded-field border border-absent/30 bg-absent-bg px-4 py-3 text-sm text-absent">{error}</div>}
      {notice && <div role="status" className="rounded-field border border-present/30 bg-present-bg px-4 py-3 text-sm text-present">{notice}</div>}

      <Card>
        <CardHeader title="Class and devices" description="Choose the class both camera sessions will serve. Stop both cameras before switching classes." action={<Button variant="secondary" size="sm" onClick={refreshCameras} loading={busy}>Refresh cameras</Button>} />
        <CardBody className="max-w-lg">
          {loading ? <div className="flex items-center gap-2 py-3 text-sm text-muted"><Spinner /> Loading classes and cameras…</div> : (
            <Field label="Class / section" required>
              <Select value={sectionId} onChange={(event) => setSection(event.target.value)} disabled={!sections.length || busy || running.length > 0}>
                {!sections.length && <option value="">No assigned classes</option>}
                {sections.map((section: SectionOption) => <option key={section.id} value={section.id}>{section.branch} · Year {section.year} · Section {section.section}</option>)}
              </Select>
            </Field>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        {renderCameraSlot("entry", entryRun, entrySource, setEntrySource)}
        {renderCameraSlot("exit", exitRun, exitSource, setExitSource)}
      </div>

      {entrySource && entrySource === exitSource && (!entryRun || !exitRun) && (
        <Alert tone="warning" title="Choose two different cameras for both views">
          One camera device can run only one recognition direction at a time. Select a separate camera for Entry and Exit to run both previews together.
        </Alert>
      )}

      <Alert tone="info" title="Review students the cameras did not see">
        A missing face detection is not enough to conclude a student was absent. Review unobserved students in <Link className="font-semibold text-brand underline" to={`/teacher/classes?section=${encodeURIComponent(sectionId)}&date=${isoToday()}`}>Attendance monitoring</Link>; select the scheduled period, confirm the student, and mark Absent when appropriate. Camera video is transient and is not recorded.
      </Alert>

      {otherRunning.length > 0 && (
        <Card>
          <CardHeader title="Other active camera sessions" description="Sessions for this teacher remain active until stopped." />
          <CardBody className="space-y-3">
            {otherRunning.map((camera) => {
              const section = sections.find((item) => item.id === camera.sectionId);
              return (
                <div key={camera.source} className="flex flex-wrap items-center justify-between gap-3 rounded-field border border-line p-3">
                  <div>
                    <p className="text-sm font-medium text-ink">{camera.name} · {camera.eventType === "entry" ? "Entry" : "Exit"}</p>
                    <p className="mt-1 text-xs text-muted">{section ? `${section.branch} · Year ${section.year} · Section ${section.section}` : camera.sectionId}</p>
                  </div>
                  <Button variant="danger" size="sm" onClick={() => void stopCamera(camera)} loading={busy}>Stop session</Button>
                </div>
              );
            })}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
