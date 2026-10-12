import { Link } from "react-router-dom";

import { PageBody, PageHeader } from "../../components/AppShell";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  KeyValue,
} from "../../components/ui";
import { useAuth } from "../../lib/auth";

export default function StudentProfile() {
  const { user } = useAuth();
  if (!user || user.role !== "student") return null;
  const student = user.profile;

  return (
    <PageBody>
      <PageHeader
        title="Your profile"
        description="These details decide which periods appear on your dashboard and how attendance is filed."
        actions={
          <Badge tone={student.faceEnrolled ? "present" : "late"}>
            {student.faceEnrolled ? "Face enrolled" : "Face not enrolled"}
          </Badge>
        }
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Student record" />
          <CardBody>
            <dl className="flex flex-col gap-1">
              <KeyValue label="Name" value={student.name} />
              <KeyValue label="Roll number" value={student.studentId} />
              <KeyValue label="Email" value={student.email} />
              <KeyValue label="Branch" value={student.branch} />
              <KeyValue label="Year" value={student.year} />
              <KeyValue label="Section" value={student.section} />
              <KeyValue label="Class" value={student.sectionId} />
              <KeyValue label="Joined" value={student.joinedAt} />
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Face recognition"
            description="How the camera knows it is you."
          />
          <CardBody className="flex flex-col gap-4">
            <dl className="flex flex-col gap-1">
              <KeyValue
                label="Enrolment embedding"
                value={student.faceEnrolled ? "Stored" : "Missing"}
              />
              <KeyValue
                label="Extra views learned"
                value={`${student.harvestedReferences} of 4`}
              />
            </dl>

            <p className="text-xs leading-relaxed text-muted">
              Enrolment stores exactly one embedding — the numbers your registration photo produced.
              During class the camera can add up to four more views, but only from confident,
              genuinely different angles. That is what keeps recognition working when you change
              your hairstyle or the light changes; it never learns from a guess.
            </p>

            {!student.faceEnrolled && (
              <Alert tone="warning" title="You cannot be marked automatically yet">
                Capture one photo so the recogniser has something to match against.
              </Alert>
            )}

            <div>
              <Link to="/student/enroll">
                <Button variant={student.faceEnrolled ? "secondary" : "primary"}>
                  {student.faceEnrolled ? "Re-enrol my face" : "Enrol my face"}
                </Button>
              </Link>
            </div>
          </CardBody>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader
          title="What is stored about you"
          description="Worth being precise, because this is biometric data."
        />
        <CardBody className="grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-[13px] font-medium text-ink">No photos</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              The image used at enrolment is not saved. Only the 128-number embedding that the
              model produced from it is.
            </p>
          </div>
          <div>
            <p className="text-[13px] font-medium text-ink">Attendance rows</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              One row per period: your roll number, the date, the subject and the time. Nothing
              about your face travels with it.
            </p>
          </div>
          <div>
            <p className="text-[13px] font-medium text-ink">Kept on the college database</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Everything lives in the same local SQLite file the camera writes to. There is no
              third-party service in this flow.
            </p>
          </div>
        </CardBody>
      </Card>
    </PageBody>
  );
}
