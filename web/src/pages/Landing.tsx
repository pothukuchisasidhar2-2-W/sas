import { Link } from "react-router-dom";

import { Wordmark } from "../components/AppShell";
import { Badge, Button, Card } from "../components/ui";

const STEPS = [
  {
    step: "01",
    title: "Enrol once, in the browser",
    body: "A student signs up with their roll number, branch, year and section, then captures one photo. That frame is turned into a face embedding — the same YuNet + SFace pipeline the camera already uses.",
  },
  {
    step: "02",
    title: "Teachers record each period",
    body: "Teachers mark attendance against the scheduled class. When the session is complete, any remaining approved students are recorded absent. The existing camera recogniser still records date-only attendance and is not yet connected to class periods.",
  },
  {
    step: "03",
    title: "Everyone sees the same numbers",
    body: "Students get today's classes and a per-subject percentage. Teachers get the roster they are actually assigned to. HODs get the department rollup.",
  },
];

const ROLES = [
  {
    title: "Students",
    points: [
      "Today's periods and their status at a glance",
      "A day picker to look back at any date",
      "Per-subject attendance percentage, with the 75% line marked",
      "Their own timetable, not a screenshot on a noticeboard",
    ],
  },
  {
    title: "Teachers & HODs",
    points: [
      "See attendance for assigned classes and, for HODs, department classes",
      "Record and correct attendance for scheduled periods",
      "Complete a session to record remaining students as absent",
      "Upload the timetable for your sections",
      "Optionally create or join a department to coordinate with colleagues",
    ],
  },
];

export default function Landing() {
  return (
    <div className="min-h-full bg-surface">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-6">
        <Wordmark />
        <div className="flex items-center gap-2">
          <Link to="/login">
            <Button variant="ghost" size="sm">
              Sign in
            </Button>
          </Link>
          <Link to="/signup">
            <Button size="sm">Create account</Button>
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-5 sm:px-6">
        {/* Hero */}
        <section className="border-t border-line py-16 sm:py-24">
          <Badge tone="brand">Face recognition · runs locally</Badge>
          <h1 className="mt-5 max-w-3xl text-4xl font-semibold leading-[1.1] tracking-tight text-ink sm:text-5xl">
            Attendance that marks itself.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted">
            A face is enrolled once. From then on a camera recognises who is in the room and
            records the period — and students, teachers and the department head all read from the
            same record instead of three different registers.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/signup">
              <Button size="md">Get started</Button>
            </Link>
            <Link to="/login">
              <Button variant="secondary" size="md">
                Try a demo account
              </Button>
            </Link>
          </div>
        </section>

        {/* How it works */}
        <section className="border-t border-line py-14">
          <h2 className="text-lg font-semibold tracking-tight text-ink">How it works</h2>
          <div className="mt-8 grid gap-8 sm:grid-cols-3">
            {STEPS.map((item) => (
              <div key={item.step}>
                <p className="text-[11px] font-medium tracking-wide text-brand">{item.step}</p>
                <h3 className="mt-2 text-sm font-semibold text-ink">{item.title}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{item.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Who it is for */}
        <section className="border-t border-line py-14">
          <h2 className="text-lg font-semibold tracking-tight text-ink">Two sides, one record</h2>
          <div className="mt-8 grid gap-5 md:grid-cols-2">
            {ROLES.map((role) => (
              <Card key={role.title} className="p-6">
                <h3 className="text-sm font-semibold text-ink">{role.title}</h3>
                <ul className="mt-4 flex flex-col gap-2.5">
                  {role.points.map((point) => (
                    <li key={point} className="flex gap-2.5 text-[13px] leading-relaxed text-muted">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
                      {point}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        </section>

        {/* Departments */}
        <section className="border-t border-line py-14">
          <div className="max-w-3xl">
            <h2 className="text-lg font-semibold tracking-tight text-ink">
              Department collaboration is optional
            </h2>
            <p className="mt-3 text-[13px] leading-relaxed text-muted">
              Teachers can use their assigned classes, timetables and attendance tools without
              joining a department. When colleagues want to coordinate, an HOD can create one and
              invite teachers with a join code. Members can then share announcements, coordinate
              timetable changes and review department-wide attendance.
            </p>
          </div>
        </section>
      </main>

      <footer className="mt-8 border-t border-line py-8">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-5 text-xs text-faint sm:px-6">
          <Wordmark compact />
          <p>
            Faces are stored as numerical embeddings in a local SQLite database — never as images.
          </p>
        </div>
      </footer>
    </div>
  );
}
