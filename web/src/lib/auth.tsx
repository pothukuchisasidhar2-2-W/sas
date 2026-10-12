/* ---------------------------------------------------------------------------
   Session state for the whole app.

   The token is the only thing kept in localStorage. On boot the app asks the
   API who that token belongs to (`me`) rather than trusting anything cached —
   the same thing the real backend will require, so a stale or revoked session
   lands on the login screen instead of a half-rendered dashboard.
--------------------------------------------------------------------------- */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";

import { api, setAuthToken } from "../api/client";
import type { Session, SignupStudentInput, SignupTeacherInput } from "../api/contract";
import type { SessionUser } from "../api/types";

const TOKEN_KEY = "smart-attendance.token";

interface AuthContextValue {
  session: Session | null;
  user: SessionUser | null;
  /** True while the stored token is being validated on first paint. */
  initialising: boolean;
  login: (email: string, password: string) => Promise<SessionUser>;
  signupStudent: (input: SignupStudentInput) => Promise<SessionUser>;
  signupTeacher: (input: SignupTeacherInput) => Promise<SessionUser>;
  logout: () => Promise<void>;
  /** Re-read the signed-in profile after something changed it. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [initialising, setInitialising] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setInitialising(false);
      return;
    }
    setAuthToken(token);
    api
      .me(token)
      .then((user) => setSession({ token, user }))
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY);
        setAuthToken(null);
      })
      .finally(() => setInitialising(false));
  }, []);

  const persist = useCallback((next: Session) => {
    localStorage.setItem(TOKEN_KEY, next.token);
    setAuthToken(next.token);
    setSession(next);
    return next.user;
  }, []);

  const login = useCallback(
    async (email: string, password: string) => persist(await api.login(email, password)),
    [persist],
  );

  const signupStudent = useCallback(
    async (input: SignupStudentInput) => persist(await api.signupStudent(input)),
    [persist],
  );

  const signupTeacher = useCallback(
    async (input: SignupTeacherInput) => persist(await api.signupTeacher(input)),
    [persist],
  );

  const logout = useCallback(async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) {
      try {
        await api.logout(token);
      } catch {
        // Signing out locally must succeed even if the server call does not.
      }
    }
    localStorage.removeItem(TOKEN_KEY);
    setAuthToken(null);
    setSession(null);
  }, []);

  const refresh = useCallback(async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;
    setSession({ token, user: await api.me(token) });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      initialising,
      login,
      signupStudent,
      signupTeacher,
      logout,
      refresh,
    }),
    [session, initialising, login, signupStudent, signupTeacher, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside <AuthProvider>.");
  return context;
}

/** Convenience: the token every API call needs. */
export function useToken(): string {
  const { session } = useAuth();
  return session?.token ?? "";
}
