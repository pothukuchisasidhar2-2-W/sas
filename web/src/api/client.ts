/* ---------------------------------------------------------------------------
   The single place the UI gets its data from.

   MOCK vs REAL
   ------------
   Set VITE_API_URL (e.g. http://127.0.0.1:8000) and every call below turns into
   a real `fetch` against the Python API. Leave it unset and the mock store
   answers instead. No screen imports the mock directly, so switching over is a
   one-line environment change, not a refactor.

   The endpoint names in the comments of contract.ts ARE the routes the FastAPI
   side needs to expose; they are not decoration.
--------------------------------------------------------------------------- */

import { HttpError } from "./contract";
import type { Api } from "./contract";
import { mockApi } from "./mock";

const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
export const USING_MOCK = API_URL.length === 0;

let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    throw new HttpError(0, "Cannot reach the server. Is the API running?");
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!response.ok) {
    const detail =
      typeof payload.detail === "string"
        ? payload.detail
        : typeof payload.message === "string"
          ? payload.message
          : `Request failed (${response.status}).`;
    throw new HttpError(response.status, detail);
  }
  return payload as T;
}

/**
 * The API surface the app uses. With VITE_API_URL set, each method hits the
 * route documented in contract.ts; otherwise the mock store answers.
 */
export const api: Api = USING_MOCK
  ? mockApi
  : {
      login: (email, password) =>
        request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
      signupStudent: (input) =>
        request("/api/auth/signup/student", { method: "POST", body: JSON.stringify(input) }),
      signupTeacher: (input) =>
        request("/api/auth/signup/teacher", { method: "POST", body: JSON.stringify(input) }),
      me: () => request("/api/auth/me"),
      logout: () => request("/api/auth/logout", { method: "POST" }),

      listSections: () => request("/api/directory/sections"),
      listDepartments: () => request("/api/directory/departments"),

      studentSummary: () => request("/api/student/summary"),
      studentSchedule: (_token, date) =>
        request(`/api/student/schedule?date=${encodeURIComponent(date)}`),
      studentAttendance: (_token, from, to) =>
        request(`/api/student/attendance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
      enrollFace: (_token, imageDataUrl) =>
        request("/api/student/enrollment", {
          method: "POST",
          body: JSON.stringify({ image: imageDataUrl }),
        }),

      teacherSections: () => request("/api/teacher/assignments"),
      teacherRoster: (_token, params) => {
        const query = new URLSearchParams({
          sectionId: params.sectionId,
          date: params.date,
        });
        if (params.slotId) query.set("slotId", params.slotId);
        return request(`/api/teacher/roster?${query.toString()}`);
      },
      reviewStudent: (_token, studentId, sectionId, status) =>
        request(`/api/teacher/students/${encodeURIComponent(studentId)}/enrollment`, {
          method: "PATCH",
          body: JSON.stringify({ sectionId, status }),
        }),
      markAttendance: (_token, input) =>
        request("/api/teacher/attendance", { method: "PATCH", body: JSON.stringify(input) }),
      teacherSchedule: (_token, date) =>
        request(`/api/teacher/schedule?date=${encodeURIComponent(date)}`),
      sectionTimetable: (_token, sectionId) =>
        request(`/api/timetable?sectionId=${encodeURIComponent(sectionId)}`),
      uploadTimetable: (_token, input) =>
        request("/api/teacher/timetable/upload", { method: "POST", body: JSON.stringify(input) }),
      previewTimetable: (_token, input) =>
        request("/api/teacher/timetable/preview", { method: "POST", body: JSON.stringify(input) }),

      myDepartment: () => request("/api/departments/mine"),
      createDepartment: (_token, name) =>
        request("/api/departments", { method: "POST", body: JSON.stringify({ name }) }),
      joinDepartment: (_token, code) =>
        request("/api/departments/join", { method: "POST", body: JSON.stringify({ code }) }),
      rotateDeptCode: () => request("/api/departments/code/rotate", { method: "POST" }),
      deptMembers: () => request("/api/departments/members"),
      setMemberPermissions: (_token, userId, permissions) =>
        request(`/api/departments/members/${encodeURIComponent(userId)}/permissions`, {
          method: "PATCH",
          body: JSON.stringify({ permissions }),
        }),
      deptPosts: () => request("/api/departments/posts"),
      deptReplies: (_token, postId) =>
        request(`/api/departments/posts/${encodeURIComponent(postId)}/replies`),
      createDeptReply: (_token, postId, body) =>
        request(`/api/departments/posts/${encodeURIComponent(postId)}/replies`, {
          method: "POST",
          body: JSON.stringify({ body }),
        }),
      createDeptPost: (_token, input) =>
        request("/api/departments/posts", { method: "POST", body: JSON.stringify(input) }),
      claimDeptPost: (_token, postId) =>
        request(`/api/departments/posts/${encodeURIComponent(postId)}/claim`, { method: "POST" }),
      resolveDeptPost: (_token, postId) =>
        request(`/api/departments/posts/${encodeURIComponent(postId)}/resolve`, { method: "POST" }),
      deptAnalytics: () => request("/api/departments/analytics"),
    };

/**
 * Normalises anything thrown by either implementation into a readable message,
 * so no screen has to guess at the error shape.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

export {
  resetMockData,
  demoAccounts,
  MOCK_BRANCHES,
  MOCK_YEARS,
  MOCK_SECTIONS,
} from "./mock";
export type { DemoAccount } from "./mock";
