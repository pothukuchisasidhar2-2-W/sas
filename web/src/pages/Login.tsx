import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { USING_MOCK, demoAccounts, errorMessage, resetMockData } from "../api/client";
import { Wordmark } from "../components/AppShell";
import { GoogleSignInButton } from "../components/GoogleSignInButton";
import { Alert, Button, Card, Field, Input } from "../components/ui";
import { useAuth } from "../lib/auth";

export default function Login() {
  const { login, loginGoogle } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const accounts = USING_MOCK ? demoAccounts() : [];

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user = await login(email, password);
      navigate(user.role === "student" ? "/student" : "/teacher", { replace: true });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const signInWithGoogle = async (credential: string, nonce: string) => {
    setError(null);
    try {
      const user = await loginGoogle(credential, nonce);
      navigate(user.role === "student" ? "/student" : "/teacher", { replace: true });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <div className="grid min-h-full place-items-center bg-canvas px-4 py-10">
      <div className="w-full max-w-5xl">
        <Link to="/" className="mb-6 flex justify-center">
          <Wordmark />
        </Link>

        <div className="grid overflow-hidden rounded-card border border-line bg-surface shadow-sm lg:grid-cols-[0.8fr_1.2fr]">
        <aside className="hidden flex-col justify-between bg-gradient-to-br from-indigo-700 via-indigo-700 to-violet-800 p-9 text-white lg:flex">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-200">SAHE · Vijayawada</p>
            <h2 className="mt-12 text-3xl font-semibold leading-tight">Welcome back to your classroom.</h2>
            <p className="mt-4 text-sm leading-6 text-indigo-100">Sign in securely to see the attendance information for your role and classes.</p>
          </div>
          <p className="text-sm text-indigo-200">One secure account for students and teachers.</p>
        </aside>
        <Card className="rounded-none border-0 p-6 shadow-none sm:p-8">
          <h1 className="text-lg font-semibold tracking-tight text-ink">Sign in</h1>
          <p className="mt-1 text-[13px] text-muted">
            One sign-in for students and teachers — you land on the right dashboard automatically.
          </p>

          {!USING_MOCK && <div className="mt-6"><GoogleSignInButton mode="signin" onCredential={signInWithGoogle} /></div>}

          {!USING_MOCK && <div className="my-5 flex items-center gap-3 text-xs text-faint">
            <span className="h-px flex-1 bg-line" /><span>OR USE EMAIL AND PASSWORD</span><span className="h-px flex-1 bg-line" />
          </div>}

          <form className={`${USING_MOCK ? "mt-6" : "mt-0"} flex flex-col gap-4`} onSubmit={submit}>
            <Field label="Email" required>
              <Input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </Field>

            <Field label="Password" required>
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
              />
            </Field>

            {error && <Alert tone="error">{error}</Alert>}

            <Button type="submit" loading={busy} className="w-full">
              Sign in
            </Button>
          </form>

          <p className="mt-3 text-right text-[13px]">
            <Link to="/forgot-password" className="font-medium text-brand hover:underline">Forgot password?</Link>
          </p>

          <p className="mt-5 text-center text-[13px] text-muted">
            No account yet?{" "}
            <Link to="/signup" className="font-medium text-brand hover:underline">
              Create one
            </Link>
          </p>
        </Card>
        </div>

        {accounts.length > 0 && (
          <Card className="mt-4 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
                Demo accounts
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  resetMockData();
                  setError(null);
                }}
                title="Clear accounts and timetable created in this browser"
              >
                Reset demo data
              </Button>
            </div>
            <div className="mt-3 flex flex-col gap-1.5">
              {accounts.map((account) => (
                <button
                  key={account.email}
                  type="button"
                  onClick={() => {
                    setEmail(account.email);
                    setPassword(account.password);
                    setError(null);
                  }}
                  className="flex items-center justify-between gap-3 rounded-field border border-line px-3 py-2 text-left transition-colors hover:bg-canvas"
                >
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-ink">{account.label}</span>
                    <span className="block truncate text-[11px] text-muted">{account.detail}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-faint">Use →</span>
                </button>
              ))}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-faint">
              Clicking a row fills the form. Password for every demo account is{" "}
              <code className="text-muted">demo1234</code>. This build talks to an in-browser mock,
              so nothing is sent anywhere.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
