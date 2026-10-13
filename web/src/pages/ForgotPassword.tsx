import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { completePasswordReset, errorMessage, requestAuthCode } from "../api/client";
import { Wordmark } from "../components/AppShell";
import { Alert, Button, Card, Field, Input } from "../components/ui";

export default function ForgotPassword() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const sendCode = async () => {
    setError(null); setBusy(true);
    try { await requestAuthCode(email.trim(), "reset"); setSent(true); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError(null); setBusy(true);
    try { await completePasswordReset(email.trim(), code, password); setSuccess(true); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };

  return <div className="grid min-h-full place-items-center bg-canvas px-4 py-10"><div className="w-full max-w-md">
    <Link to="/" className="mb-6 flex justify-center"><Wordmark /></Link>
    <Card className="p-6">
      <h1 className="text-lg font-semibold tracking-tight text-ink">Reset your password</h1>
      <p className="mt-1 text-[13px] text-muted">We’ll send a one-time code to your Gmail inbox. It expires after 10 minutes.</p>
      {success ? <div className="mt-5 flex flex-col gap-4"><Alert tone="info">Your password has been updated. Sign in with your new password.</Alert><Button onClick={() => navigate("/login", { replace: true })}>Go to sign in</Button></div> : <>
        <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"><Field label="Gmail" required><Input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@gmail.com" /></Field><Button type="button" variant="secondary" loading={busy && !sent} disabled={!email.includes("@")} onClick={sendCode}>{sent ? "Resend code" : "Send code"}</Button></div>
        <form className="mt-4 flex flex-col gap-4" onSubmit={submit}>
          <Field label="One-time code" required><Input required inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" value={code} onChange={(event) => setCode(event.target.value)} placeholder="6-digit code" /></Field>
          <Field label="New password" required hint="At least 8 characters."><Input required type="password" minLength={8} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
          {error && <Alert tone="error">{error}</Alert>}
          <Button type="submit" loading={busy} disabled={!sent}>Update password</Button>
        </form>
      </>}
      <p className="mt-5 text-center text-[13px] text-muted"><Link to="/login" className="font-medium text-brand hover:underline">Back to sign in</Link></p>
    </Card>
  </div></div>;
}
