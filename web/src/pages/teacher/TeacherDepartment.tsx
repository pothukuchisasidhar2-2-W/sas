import { useState } from "react";

import { api, errorMessage } from "../../api/client";
import { PageBody, PageHeader } from "../../components/AppShell";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  ProgressBar,
  Select,
  Spinner,
  StatTile,
  TableWrap,
  Tabs,
  Td,
  Textarea,
  Th,
  cx,
} from "../../components/ui";
import type { DeptMember, DeptPermissions, DeptPost, DeptPostKind } from "../../api/types";
import { useAuth, useToken } from "../../lib/auth";
import { formatPercentage, percentageTone } from "../../lib/format";
import { useApiData } from "../../lib/useApiData";

const PERMISSION_LABELS: Array<{ key: keyof DeptPermissions; label: string; hint: string }> = [
  { key: "manageTimetable", label: "Timetable", hint: "Upload and edit class schedules" },
  { key: "markAttendance", label: "Attendance", hint: "Correct or add attendance marks" },
  { key: "enrollStudents", label: "Enrol students", hint: "Add students to classes" },
  { key: "postAnnouncements", label: "Announcements", hint: "Post to the department board" },
  { key: "viewAnalytics", label: "Analytics", hint: "See department-wide attendance figures" },
];

const POST_KIND_LABELS: Record<DeptPostKind, string> = {
  announcement: "Announcement",
  coverage_request: "Coverage needed",
  timetable_change: "Timetable change",
};

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/* ------------------------------------------------------------------ no dept */

function JoinOrCreate({
  onDone,
  suggestedName,
}: {
  onDone: () => void;
  suggestedName: string;
}) {
  const token = useToken();
  const [name, setName] = useState(suggestedName);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const directory = useApiData([token], () => api.listDepartments());

  const run = async (action: "create" | "join") => {
    setBusy(action);
    setError(null);
    try {
      if (action === "create") await api.createDepartment(token, name);
      else await api.joinDepartment(token, code);
      onDone();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Create a department"
            description="You become its HOD and can generate a one-time join code to share."
          />
          <CardBody className="flex flex-col gap-4">
            <Field label="Department name" required>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Computer Science & Engineering"
              />
            </Field>
            <div>
              <Button onClick={() => run("create")} loading={busy === "create"} disabled={!name.trim()}>
                Create and become HOD
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-muted">
              Other teachers join with a one-time code. Only you can rotate that code or change what
              a member is allowed to do.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Join with a code"
            description="Your HOD generated this code for you."
          />
          <CardBody className="flex flex-col gap-4">
            <Field label="Department code" required hint="Case and spaces do not matter.">
              <Input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="CSE-7X4K-9QP2"
                className="font-mono"
              />
            </Field>
            <div>
              <Button
                variant="secondary"
                onClick={() => run("join")}
                loading={busy === "join"}
                disabled={!code.trim()}
              >
                Join department
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-muted">
              Ask your HOD for the code — it is deliberately not listed anywhere public.
            </p>
          </CardBody>
        </Card>
      </div>

      {error && (
        <div className="mt-5">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      <Card className="mt-5">
        <CardHeader
          title="Departments on this system"
          description="Names and sizes only — join codes are never exposed in a listing."
        />
        {directory.loading ? (
          <div className="flex items-center justify-center py-10 text-muted">
            <Spinner />
          </div>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>Department</Th>
                <Th>HOD</Th>
                <Th align="right">Members</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {(directory.data ?? []).map((dept) => (
                <tr key={dept.id} className="hover:bg-canvas">
                  <Td className="font-medium">{dept.name}</Td>
                  <Td className="text-muted">{dept.hodName}</Td>
                  <Td align="right" className="tabular-nums">
                    {dept.memberCount}
                  </Td>
                  <Td className="text-muted">{dept.createdAt}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </>
  );
}

/* ---------------------------------------------------------------- access tab */

function AccessTab({
  members,
  isHod,
  onChanged,
}: {
  members: DeptMember[];
  isHod: boolean;
  onChanged: () => void;
}) {
  const token = useToken();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (member: DeptMember, key: keyof DeptPermissions) => {
    setBusy(member.userId);
    setError(null);
    try {
      await api.setMemberPermissions(token, member.userId, {
        ...member.permissions,
        [key]: !member.permissions[key],
      });
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Members and access"
        description={
          isHod
            ? "Click any permission to grant or revoke it. Changes apply immediately."
            : "Read-only — only the HOD can change what a member may do."
        }
      />

      {error && (
        <CardBody>
          <Alert tone="error">{error}</Alert>
        </CardBody>
      )}

      <TableWrap>
        <thead>
          <tr>
            <Th>Member</Th>
            <Th>Role</Th>
            <Th>Classes</Th>
            {PERMISSION_LABELS.map((permission) => (
              <Th key={permission.key} align="center">
                {permission.label}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {members.map((member) => {
            const isSelf = member.role === "hod";
            return (
              <tr key={member.userId} className="hover:bg-canvas">
                <Td>
                  <p className="font-medium">{member.name}</p>
                  <p className="mt-0.5 text-[11px] text-muted">{member.email}</p>
                </Td>
                <Td>
                  <Badge tone={member.role === "hod" ? "brand" : "neutral"}>
                    {member.role === "hod" ? "HOD" : "Admin"}
                  </Badge>
                </Td>
                <Td className="text-[11px] text-muted">
                  {member.assignedSections.length > 0 ? member.assignedSections.join(", ") : "—"}
                </Td>
                {PERMISSION_LABELS.map((permission) => {
                  const granted = member.permissions[permission.key];
                  const editable = isHod && !isSelf;
                  return (
                    <Td key={permission.key} align="center">
                      <button
                        type="button"
                        disabled={!editable || busy === member.userId}
                        title={
                          editable
                            ? `${granted ? "Revoke" : "Grant"} ${permission.label}: ${permission.hint}`
                            : permission.hint
                        }
                        onClick={() => toggle(member, permission.key)}
                        className={cx(
                          "inline-flex h-6 w-11 items-center rounded-full px-0.5 transition-colors",
                          granted ? "bg-brand" : "bg-line-strong",
                          editable ? "cursor-pointer" : "cursor-default opacity-70",
                        )}
                        aria-pressed={granted}
                        aria-label={`${permission.label} for ${member.name}`}
                      >
                        <span
                          className={cx(
                            "size-5 rounded-full bg-surface transition-transform",
                            granted && "translate-x-5",
                          )}
                        />
                      </button>
                    </Td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </TableWrap>

      <CardBody className="border-t border-line">
        <p className="text-xs leading-relaxed text-muted">
          The HOD's own access cannot be reduced — otherwise a department could lock itself out.
        </p>
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ board tab */

function DiscussionReplies({ postId }: { postId: string }) {
  const token = useToken();
  const replies = useApiData([token, postId], () => api.deptReplies(token, postId));
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createDeptReply(token, postId, body);
      setBody("");
      replies.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t border-line pt-3">
      {(replies.data ?? []).map((reply) => (
        <div key={reply.id} className="mb-2 rounded-field bg-canvas px-3 py-2">
          <p className="text-[11px] font-medium text-ink">{reply.authorName} <span className="font-normal text-faint">· {timeAgo(reply.createdAt)}</span></p>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted">{reply.body}</p>
        </div>
      ))}
      {error && <Alert tone="error">{error}</Alert>}
      <div className="mt-2 flex items-end gap-2">
        <Textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Reply to this discussion…" className="min-h-16" />
        <Button size="sm" onClick={submit} loading={busy} disabled={!body.trim()}>Reply</Button>
      </div>
    </div>
  );
}

function BoardTab({ canPost, onChanged }: { canPost: boolean; onChanged: () => void }) {
  const token = useToken();
  const posts = useApiData([token], () => api.deptPosts(token));
  const [kind, setKind] = useState<DeptPostKind>("announcement");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const post = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createDeptPost(token, { kind, title, body });
      setTitle("");
      setBody("");
      posts.reload();
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const act = async (post_: DeptPost, action: "claim" | "resolve") => {
    setBusy(true);
    setError(null);
    try {
      if (action === "claim") await api.claimDeptPost(token, post_.id);
      else await api.resolveDeptPost(token, post_.id);
      posts.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <Card>
        <CardHeader
          title="Department board"
          description="The things that actually need saying: a period needing cover, a timetable that moved, an audit that is due."
        />
        {posts.loading ? (
          <div className="flex items-center justify-center py-12 text-muted">
            <Spinner />
          </div>
        ) : (posts.data ?? []).length === 0 ? (
          <EmptyState
            title="Nothing posted yet"
            description="Start with a coverage request when you need a period taken."
          />
        ) : (
          <ul className="divide-y divide-line">
            {(posts.data ?? []).map((item) => (
              <li key={item.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={item.kind === "coverage_request" ? "late" : "neutral"}>
                    {POST_KIND_LABELS[item.kind]}
                  </Badge>
                  {item.status === "resolved" && <Badge tone="present">Resolved</Badge>}
                  <span className="text-[11px] text-faint">
                    {item.authorName} · {timeAgo(item.createdAt)}
                  </span>
                </div>
                <p className="mt-2 text-[13px] font-medium text-ink">{item.title}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">{item.body}</p>

                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  {item.claimedByName && (
                    <span className="text-[11px] text-muted">
                      Claimed by <span className="font-medium text-ink">{item.claimedByName}</span>
                    </span>
                  )}
                  {item.status === "open" && item.kind === "coverage_request" && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => act(item, "claim")}
                    >
                      {item.claimedByUserId ? "Reassign to me" : "I'll cover it"}
                    </Button>
                  )}
                  {item.status === "open" && (
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => act(item, "resolve")}>
                      Mark resolved
                    </Button>
                  )}
                </div>
                <DiscussionReplies postId={item.id} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Post to the board" />
        <CardBody className="flex flex-col gap-4">
          <Field label="Type">
            <Select value={kind} onChange={(event) => setKind(event.target.value as DeptPostKind)}>
              <option value="announcement">Announcement</option>
              <option value="coverage_request">Coverage needed</option>
              <option value="timetable_change">Timetable change</option>
            </Select>
          </Field>

          <Field label="Title" required>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>

          <Field label="Details">
            <Textarea value={body} onChange={(event) => setBody(event.target.value)} />
          </Field>

          {error && <Alert tone="error">{error}</Alert>}

          <Button onClick={post} loading={busy} disabled={!title.trim()}>
            Publish
          </Button>

          {!canPost && (
            <Alert tone="warning">
              Your HOD has not given you permission to post announcements. You can still raise a
              coverage request.
            </Alert>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------- analytics tab */

function AnalyticsTab() {
  const token = useToken();
  const analytics = useApiData([token], () => api.deptAnalytics(token));
  const rows = analytics.data ?? [];

  if (analytics.loading) {
    return (
      <div className="flex items-center justify-center py-14 text-muted">
        <Spinner />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          title="Nothing to analyse yet"
          description="Either you have no classes in scope, or your HOD has not granted you analytics access."
        />
      </Card>
    );
  }

  const observedRates = rows.flatMap((row) => row.presentRate === null ? [] : [row.presentRate]);
  const worst = observedRates.length > 0 ? Math.min(...observedRates) : null;
  const knownRiskRows = rows.filter((row) => row.atRiskCount !== null);
  const totalAtRisk = knownRiskRows.reduce((total, row) => total + (row.atRiskCount ?? 0), 0);
  const incomplete = knownRiskRows.length < rows.length;

  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Class–subject pairs" value={rows.length} />
        <StatTile
          label="Worst attendance"
          value={formatPercentage(worst)}
          tone={percentageTone(worst).text}
        />
        <StatTile
          label="Students below threshold"
          value={incomplete ? `${totalAtRisk}+` : totalAtRisk}
          hint={incomplete ? "More marks needed for a complete count" : undefined}
          tone={totalAtRisk > 0 ? "text-absent" : "text-present"}
        />
        <StatTile
          label="Sessions recorded"
          value={rows.reduce((total, row) => total + row.sessionsHeld, 0)}
        />
      </div>

      <Card>
        <CardHeader
          title="Attendance by class and subject"
          description="Present and late count as attended; excused is excluded from both sides."
        />
        <TableWrap>
          <thead>
            <tr>
              <Th>Class</Th>
              <Th>Subject</Th>
              <Th align="right">Sessions</Th>
              <Th>Attendance</Th>
              <Th align="right">Below threshold</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const tone = percentageTone(row.presentRate);
              return (
                <tr key={`${row.sectionId}-${row.subjectCode}`} className="hover:bg-canvas">
                  <Td className="font-medium">{row.sectionId}</Td>
                  <Td>
                    <span className="font-medium">{row.subjectCode}</span>
                    <span className="ml-2 text-[11px] text-muted">{row.subjectName}</span>
                  </Td>
                  <Td align="right" className="tabular-nums text-muted">
                    {row.sessionsHeld}
                  </Td>
                  <Td>
                    <div className="flex items-center gap-3">
                      <ProgressBar
                        value={row.presentRate}
                        barClassName={tone.bar}
                        className="w-32"
                        label={`${row.subjectCode} attendance`}
                      />
                      <span className={cx("text-[13px] font-medium tabular-nums", tone.text)}>
                        {formatPercentage(row.presentRate)}
                      </span>
                    </div>
                  </Td>
                  <Td align="right">
                    {row.atRiskCount === null ? (
                      <span className="text-muted">Incomplete</span>
                    ) : row.atRiskCount > 0 ? (
                      <Badge tone="absent">
                        {row.atRiskCount} of {row.strength}
                      </Badge>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      </Card>
    </>
  );
}

/* ----------------------------------------------------------------- main page */

type TabId = "access" | "board" | "analytics";

export default function TeacherDepartment() {
  const { user, refresh } = useAuth();
  const token = useToken();
  const [tab, setTab] = useState<TabId>("access");
  const [copied, setCopied] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);

  const department = useApiData([token], () => api.myDepartment(token));
  const members = useApiData([token], () => api.deptMembers(token));

  if (!user || user.role !== "teacher") return null;
  const teacher = user.profile;

  const reloadAll = () => {
    department.reload();
    members.reload();
    void refresh();
  };

  if (department.loading) {
    return (
      <PageBody>
        <div className="flex items-center justify-center gap-2 py-20 text-muted">
          <Spinner />
          <span className="text-[13px]">Loading your department…</span>
        </div>
      </PageBody>
    );
  }

  if (!department.data) {
    return (
      <PageBody>
        <PageHeader
          title="Department"
          description="A department is how several teachers share a timetable, a roster and a board. You are not in one yet."
        />
        <JoinOrCreate onDone={reloadAll} suggestedName={teacher.departmentName ?? ""} />
      </PageBody>
    );
  }

  const dept = department.data;
  const memberList = members.data ?? [];
  const me = memberList.find((member) => member.userId === teacher.userId);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(joinCode || dept.joinCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCodeError("Copying failed — select the code and copy it manually.");
    }
  };

  const rotate = async () => {
    setRotating(true);
    setCodeError(null);
    try {
      const rotated = await api.rotateDeptCode(token);
      setJoinCode(rotated.joinCode);
    } catch (cause) {
      setCodeError(errorMessage(cause));
    } finally {
      setRotating(false);
    }
  };

  return (
    <PageBody>
      <PageHeader
        title={dept.name}
        description={`HOD ${dept.hodName} · ${dept.memberCount} member${dept.memberCount === 1 ? "" : "s"} · created ${dept.createdAt}`}
        actions={<Badge tone="brand">{teacher.isHod ? "You are the HOD" : "Member"}</Badge>}
      />

      {/* Join code panel */}
      <Card className="mb-5">
        <CardHeader
          title={teacher.isHod ? "Join code" : "Joining"}
          description={
            teacher.isHod
              ? "Share this with the teachers who should join. Rotating it invalidates the old code immediately."
              : "Only your HOD can see the department's join code."
          }
        />
        <CardBody>
          {teacher.isHod ? (
            <div className="flex flex-wrap items-center gap-3">
              <code className="rounded-field border border-line bg-canvas px-3.5 py-2 font-mono text-sm tracking-wide text-ink">
                {joinCode || dept.joinCode || "Generate a code to share"}
              </code>
              <Button variant="secondary" size="sm" onClick={copyCode} disabled={!joinCode && !dept.joinCode}>
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button variant="ghost" size="sm" onClick={rotate} loading={rotating}>
                Rotate code
              </Button>
            </div>
          ) : (
            <p className="text-[13px] text-muted">
              Ask {dept.hodName} for the code if a colleague needs to join.
            </p>
          )}
          {codeError && (
            <div className="mt-3">
              <Alert tone="error">{codeError}</Alert>
            </div>
          )}
        </CardBody>
      </Card>

      <div className="mb-5">
        <Tabs
          tabs={[
            { id: "access", label: "Members & access", count: memberList.length },
            { id: "board", label: "Board" },
            { id: "analytics", label: "Analytics" },
          ]}
          active={tab}
          onChange={setTab}
        />
      </div>

      {tab === "access" &&
        (members.loading ? (
          <div className="flex items-center justify-center py-14 text-muted">
            <Spinner />
          </div>
        ) : (
          <AccessTab members={memberList} isHod={teacher.isHod} onChanged={reloadAll} />
        ))}

      {tab === "board" && (
        <BoardTab canPost={me?.permissions.postAnnouncements ?? true} onChanged={reloadAll} />
      )}

      {tab === "analytics" && <AnalyticsTab />}
    </PageBody>
  );
}
