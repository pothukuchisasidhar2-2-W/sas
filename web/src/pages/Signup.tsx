import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { MOCK_BRANCHES, MOCK_SECTIONS, MOCK_YEARS, USING_MOCK, errorMessage, requestAuthCode } from "../api/client";
import { Wordmark } from "../components/AppShell";
import { Alert, Button, Card, Field, Input, Select, cx } from "../components/ui";
import { useAuth } from "../lib/auth";

type Role = "student" | "teacher";

interface AssignmentDraft {
  subjectCode: string;
  subjectName: string;
  branch: string;
  year: number;
  section: string;
}

const emptyAssignment = (): AssignmentDraft => ({
  subjectCode: "",
  subjectName: "",
  branch: MOCK_BRANCHES[0],
  year: 3,
  section: MOCK_SECTIONS[0],
});

export default function Signup() {
  const { signupStudent, signupTeacher } = useAuth();
  const navigate = useNavigate();

  const [role, setRole] = useState<Role>("student");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");

  // Student fields
  const [studentId, setStudentId] = useState("");
  const [branch, setBranch] = useState(MOCK_BRANCHES[0]);
  const [year, setYear] = useState(3);
  const [section, setSection] = useState(MOCK_SECTIONS[0]);

  // Teacher fields
  const [departmentName, setDepartmentName] = useState("");
  const [assignments, setAssignments] = useState<AssignmentDraft[]>([emptyAssignment()]);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);

  const sendCode = async () => {
    setError(null);
    setSendingCode(true);
    try {
      await requestAuthCode(email.trim(), "signup");
      setCodeSent(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSendingCode(false);
    }
  };

  const updateAssignment = (index: number, patch: Partial<AssignmentDraft>) => {
    setAssignments((current) =>
      current.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Choose a password of at least 8 characters.");
      return;
    }

    setBusy(true);
    try {
      if (role === "student") {
        if (!studentId.trim()) throw new Error("Enter your roll number.");
        const user = await signupStudent({
          name: name.trim(),
          email: email.trim(),
          emailCode,
          password,
          branch,
          year,
          section,
          studentId: studentId.trim(),
        });
        // Students go straight to face enrolment — an account without an
        // embedding cannot be recognised by the camera.
        navigate(user.role === "student" ? "/student/enroll" : "/student", { replace: true });
      } else {
        const cleaned = assignments.filter((a) => a.subjectCode.trim());
        if (USING_MOCK && cleaned.length === 0) {
          throw new Error("Add at least one class you are managing (subject code and section).");
        }
        const user = await signupTeacher({
          name: name.trim(),
          email: email.trim(),
          emailCode,
          password,
          departmentName,
          assignments: cleaned.map((a) => ({
            ...a,
            subjectCode: a.subjectCode.trim().toUpperCase(),
            subjectName: a.subjectName.trim() || a.subjectCode.trim().toUpperCase(),
          })),
          inviteCode: inviteCode.trim(),
        });
        navigate(user.role === "teacher" ? "/teacher" : "/", { replace: true });
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full bg-canvas px-4 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <Link to="/" className="mb-6 flex justify-center">
          <Wordmark />
        </Link>

        <Card className="p-6">
          <h1 className="text-lg font-semibold tracking-tight text-ink">Create your account</h1>
          <p className="mt-1 text-[13px] text-muted">
            Students enter their class details and capture a face photo. A teacher reviews class membership.
          </p>

          {/* Role switch */}
          <div className="mt-5 grid grid-cols-2 gap-1 rounded-field border border-line bg-surface p-1">
            {(["student", "teacher"] as Role[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setRole(option);
                  setError(null);
                }}
                aria-pressed={role === option}
                className={cx(
                  "rounded-[6px] px-3 py-2 text-[13px] font-medium transition-colors",
                  role === option ? "bg-brand-soft text-brand" : "text-muted hover:bg-canvas",
                )}
              >
                {option === "student" ? "I am a student" : "I am a teacher"}
              </button>
            ))}
          </div>

          <form className="mt-6 flex flex-col gap-4" onSubmit={submit}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Full name" required>
                <Input
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Sasidhar P"
                />
              </Field>
              <Field label="Email" required>
                <Input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@gmail.com"
                />
              </Field>
            </div>

            {!USING_MOCK && <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <Field label="Gmail verification code" required hint="Send a one-time code to verify you control this Gmail inbox. Codes expire in 10 minutes.">
                <Input required inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" value={emailCode} onChange={(event) => setEmailCode(event.target.value)} placeholder="6-digit code" />
              </Field>
              <Button type="button" variant="secondary" loading={sendingCode} onClick={sendCode} disabled={!email.includes("@")}>{codeSent ? "Resend code" : "Send code"}</Button>
            </div>}
            {USING_MOCK && <div className="flex gap-3">
              <Field label="Gmail verification code" required hint="In demo mode, enter any six digits.">
                <Input required inputMode="numeric" maxLength={6} pattern="[0-9]{6}" value={emailCode} onChange={(event) => setEmailCode(event.target.value)} placeholder="123456" />
              </Field>
            </div>}

            <Field
              label="Password"
              required
              hint="At least 8 characters. Store nothing sensitive in it."
            >
              <Input
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
              />
            </Field>

            {role === "teacher" && <Field
              label="Institution activation code"
              required
              hint="Ask an authorized department or attendance operator for your one-time code."
            >
              <Input
                required
                autoComplete="off"
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
                placeholder="Paste your activation code"
              />
            </Field>}

            {/* ------------------------------------------------ student block */}
            {role === "student" && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Roll number"
                    required
                    hint="This is the ID the camera uses to record your attendance, so it must match your college roll number."
                  >
                    <Input
                      required
                      value={studentId}
                      onChange={(event) => setStudentId(event.target.value)}
                      placeholder="4377"
                      inputMode="numeric"
                    />
                  </Field>
                  {USING_MOCK && <Field label="Branch" required>
                    <Select value={branch} onChange={(event) => setBranch(event.target.value)}>
                      {MOCK_BRANCHES.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </Select>
                  </Field>}
                  {!USING_MOCK && <Field label="Branch / programme" required>
                    <Input required value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="CSE" />
                  </Field>}
                </div>

                {USING_MOCK && <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Year" required>
                    <Select
                      value={year}
                      onChange={(event) => setYear(Number(event.target.value))}
                    >
                      {MOCK_YEARS.map((option) => (
                        <option key={option} value={option}>
                          Year {option}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Class / section" required>
                    <Select value={section} onChange={(event) => setSection(event.target.value)}>
                      {MOCK_SECTIONS.map((option) => (
                        <option key={option} value={option}>
                          Section {option}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>}

                {!USING_MOCK && <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Year" required>
                    <Input required type="number" min={1} max={8} value={year} onChange={(event) => setYear(Number(event.target.value))} />
                  </Field>
                  <Field label="Class / section" required>
                    <Input required value={section} onChange={(event) => setSection(event.target.value)} placeholder="A" />
                  </Field>
                </div>}

                {!USING_MOCK && <p className="rounded-field bg-canvas px-3.5 py-2.5 text-xs leading-relaxed text-muted">
                  Your class request starts as pending. A teacher responsible for this class will approve or reject it. You will capture your face after creating the account.
                </p>}

                {USING_MOCK && <p className="rounded-field bg-canvas px-3.5 py-2.5 text-xs leading-relaxed text-muted">
                  You will be registered as{" "}
                  <span className="font-medium text-ink">
                    {branch} · Year {year} · Section {section}
                  </span>
                  . Only attendance recorded for this class appears on your dashboard.
                </p>}
              </>
            )}

            {/* ------------------------------------------------ teacher block */}
            {role === "teacher" && (
              <>
                {!USING_MOCK && <Alert tone="info" title="Teacher access is institution controlled">
                  Department membership and teaching assignments come from your activation code.
                  You cannot grant yourself class access from this form.
                </Alert>}
                {USING_MOCK && <>
                <Field
                  label="Department name"
                  hint="Shown on your profile. To actually join a department you either create one (becoming its HOD) or enter the code your HOD shared."
                >
                  <Input
                    value={departmentName}
                    onChange={(event) => setDepartmentName(event.target.value)}
                    placeholder="Computer Science & Engineering"
                  />
                </Field>

                <div className="rounded-card border border-line">
                  <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
                    <div>
                      <p className="text-[13px] font-medium text-ink">Classes you manage</p>
                      <p className="mt-0.5 text-xs text-muted">
                        You will only ever see attendance for these sections.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setAssignments((current) => [...current, emptyAssignment()])}
                    >
                      Add class
                    </Button>
                  </div>

                  <div className="flex flex-col gap-3 p-4">
                    {assignments.map((assignment, index) => (
                      <div
                        key={index}
                        className="grid gap-3 rounded-field bg-canvas p-3 sm:grid-cols-2 lg:grid-cols-5"
                      >
                        <Field label="Subject code">
                          <Input
                            value={assignment.subjectCode}
                            onChange={(event) =>
                              updateAssignment(index, { subjectCode: event.target.value })
                            }
                            placeholder="CS301"
                          />
                        </Field>
                        <Field label="Subject name">
                          <Input
                            value={assignment.subjectName}
                            onChange={(event) =>
                              updateAssignment(index, { subjectName: event.target.value })
                            }
                            placeholder="Databases"
                          />
                        </Field>
                        <Field label="Branch">
                          <Select
                            value={assignment.branch}
                            onChange={(event) =>
                              updateAssignment(index, { branch: event.target.value })
                            }
                          >
                            {MOCK_BRANCHES.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Year">
                          <Select
                            value={assignment.year}
                            onChange={(event) =>
                              updateAssignment(index, { year: Number(event.target.value) })
                            }
                          >
                            {MOCK_YEARS.map((option) => (
                              <option key={option} value={option}>
                                Year {option}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Section">
                          <Select
                            value={assignment.section}
                            onChange={(event) =>
                              updateAssignment(index, { section: event.target.value })
                            }
                          >
                            {MOCK_SECTIONS.map((option) => (
                              <option key={option} value={option}>
                                Section {option}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        {assignments.length > 1 && (
                          <div className="lg:col-span-5">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setAssignments((current) => current.filter((_, i) => i !== index))
                              }
                            >
                              Remove this class
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                </>}
              </>
            )}

            {error && <Alert tone="error">{error}</Alert>}

            <Button type="submit" loading={busy} className="w-full">
              {role === "student" ? "Create account and capture face" : "Create teacher account"}
            </Button>
          </form>

          <p className="mt-5 text-center text-[13px] text-muted">
            Already have an account?{" "}
            <Link to="/login" className="font-medium text-brand hover:underline">
              Sign in
            </Link>
          </p>
        </Card>
      </div>
    </div>
  );
}
