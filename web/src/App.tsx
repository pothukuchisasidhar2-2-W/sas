import { Navigate, Route, Routes } from "react-router-dom";

import { Spinner } from "./components/ui";
import { useAuth } from "./lib/auth";
import StudentLayout from "./layouts/StudentLayout";
import TeacherLayout from "./layouts/TeacherLayout";
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";
import Signup from "./pages/Signup";
import StudentAttendance from "./pages/student/StudentAttendance";
import StudentDashboard from "./pages/student/StudentDashboard";
import StudentEnroll from "./pages/student/StudentEnroll";
import StudentProfile from "./pages/student/StudentProfile";
import StudentTimetable from "./pages/student/StudentTimetable";
import TeacherClasses from "./pages/teacher/TeacherClasses";
import TeacherDashboard from "./pages/teacher/TeacherDashboard";
import TeacherDepartment from "./pages/teacher/TeacherDepartment";
import TeacherTimetable from "./pages/teacher/TeacherTimetable";
import type { ReactNode } from "react";

/** Full-page splash while the stored token is validated. */
function Splash() {
  return (
    <div className="grid min-h-full place-items-center bg-canvas">
      <div className="flex flex-col items-center gap-3 text-muted">
        <Spinner className="size-5" />
        <p className="text-[13px]">Restoring your session…</p>
      </div>
    </div>
  );
}

/**
 * Guards render nothing until the session is known, so a signed-in user never
 * sees the login page flash on refresh.
 */
function RequireRole({ role, children }: { role: "student" | "teacher"; children: ReactNode }) {
  const { user, initialising } = useAuth();

  if (initialising) return <Splash />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) {
    return <Navigate to={user.role === "student" ? "/student" : "/teacher"} replace />;
  }
  return <>{children}</>;
}

/** The landing page is a marketing page — signed-in users go to their app. */
function PublicOnly({ children }: { children: ReactNode }) {
  const { user, initialising } = useAuth();
  if (initialising) return <Splash />;
  if (user) return <Navigate to={user.role === "student" ? "/student" : "/teacher"} replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          // Signed-in users are bounced straight to their dashboard, but the
          // landing page itself stays reachable at / for everyone else.
          <PublicOnly>
            <Landing />
          </PublicOnly>
        }
      />
      <Route
        path="/login"
        element={
          <PublicOnly>
            <Login />
          </PublicOnly>
        }
      />
      <Route
        path="/signup"
        element={
          <PublicOnly>
            <Signup />
          </PublicOnly>
        }
      />

      {/* Student area */}
      <Route
        path="/student"
        element={
          <RequireRole role="student">
            <StudentLayout />
          </RequireRole>
        }
      >
        <Route index element={<StudentDashboard />} />
        <Route path="attendance" element={<StudentAttendance />} />
        <Route path="timetable" element={<StudentTimetable />} />
        <Route path="enroll" element={<StudentEnroll />} />
        <Route path="profile" element={<StudentProfile />} />
      </Route>

      {/* Teacher / admin area */}
      <Route
        path="/teacher"
        element={
          <RequireRole role="teacher">
            <TeacherLayout />
          </RequireRole>
        }
      >
        <Route index element={<TeacherDashboard />} />
        <Route path="classes" element={<TeacherClasses />} />
        <Route path="timetable" element={<TeacherTimetable />} />
        <Route path="department" element={<TeacherDepartment />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
