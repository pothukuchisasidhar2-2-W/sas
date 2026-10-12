import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { USING_MOCK, demoAccounts, errorMessage, resetMockData } from "../api/client";
import { Wordmark } from "../components/AppShell";
import { Alert, Button, Card, Field, Input } from "../components/ui";
import { useAuth } from "../lib/auth";

export default function Login() {
  const { login } = useAuth();
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

  return (
    <div className="grid min-h-full place-items-center bg-canvas px-4 py-10">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-6 flex justify-center">
          <Wordmark />
        </Link>

        <Card className="p-6">
          <h1 className="text-lg font-semibold tracking-tight text-ink">Sign in</h1>
          <p className="mt-1 text-[13px] text-muted">
            One sign-in for students and teachers — you land on the right dashboard automatically.
          </p>

          <form className="mt-6 flex flex-col gap-4" onSubmit={submit}>
            <Field label="Email" required>
              <Input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@college.edu"
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

          <p className="mt-5 text-center text-[13px] text-muted">
            No account yet?{" "}
            <Link to="/signup" className="font-medium text-brand hover:underline">
              Create one
            </Link>
          </p>
        </Card>

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
