import { useEffect, useRef, useState } from "react";

import { requestGoogleNonce } from "../api/client";

interface GoogleCredentialResponse {
  credential: string;
}

interface GoogleIdentityApi {
  initialize(options: {
    client_id: string;
    nonce: string;
    callback: (response: GoogleCredentialResponse) => void;
  }): void;
  renderButton(element: HTMLElement, options: {
    theme: "outline";
    size: "large";
    shape: "rectangular";
    text: "signin_with" | "signup_with";
    width: number;
  }): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleIdentityApi } };
  }
}

const SCRIPT_URL = "https://accounts.google.com/gsi/client";

export function GoogleSignInButton({
  onCredential,
  mode = "signin",
}: {
  onCredential: (credential: string, nonce: string) => void;
  mode?: "signin" | "signup";
}) {
  const buttonRef = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onCredential);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const clientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() ?? "";

  callbackRef.current = onCredential;

  useEffect(() => {
    if (!clientId) {
      setError("Google sign-in needs VITE_GOOGLE_CLIENT_ID in web/.env.local.");
      return;
    }

    let active = true;
    let refreshTimer: number | undefined;
    const mountButton = async () => {
      if (!active || !window.google || !buttonRef.current) return;
      let nonce: string;
      try {
        nonce = (await requestGoogleNonce()).nonce;
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Google sign-in is not configured.");
        return;
      }
      if (!active || !window.google || !buttonRef.current) return;
      setError("");
      buttonRef.current.replaceChildren();
      window.google.accounts.id.initialize({
        client_id: clientId,
        nonce,
        callback: (response) => {
          if (!response.credential) {
            setError("Google did not return an account credential. Try again.");
            return;
          }
          callbackRef.current(response.credential, nonce);
        },
      });
      window.google.accounts.id.renderButton(buttonRef.current, {
        theme: "outline",
        size: "large",
        shape: "rectangular",
        text: mode === "signup" ? "signup_with" : "signin_with",
        width: Math.min(360, Math.max(260, buttonRef.current.clientWidth)),
      });
      window.clearTimeout(refreshTimer);
      // Nonces are short lived. Refresh in the background so a form left
      // open for a while still has a current nonce when Google is clicked.
      refreshTimer = window.setTimeout(() => { void mountButton(); }, 4 * 60 * 1000);
    };

    let script = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_URL}"]`);
    if (window.google) {
      void mountButton();
    } else {
      if (!script) {
        script = document.createElement("script");
        script.src = SCRIPT_URL;
        script.async = true;
        script.defer = true;
      }
      script.addEventListener("load", mountButton);
      script.addEventListener("error", () => setError("Could not load Google sign-in. Check your connection and try again."), { once: true });
      if (!script.isConnected) document.head.appendChild(script);
    }

    return () => {
      active = false;
      window.clearTimeout(refreshTimer);
      script?.removeEventListener("load", mountButton);
    };
  }, [clientId, mode, retry]);

  return (
    <div className="flex min-h-10 w-full flex-col items-center gap-2">
      <div ref={buttonRef} className="min-h-10 w-full" />
      {error && (
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-xs text-absent">
          <span>{error}</span>
          {clientId && (
            <button type="button" className="font-medium underline underline-offset-2" onClick={() => {
              const failedScript = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_URL}"]`);
              if (failedScript && !window.google) failedScript.remove();
              setError("");
              setRetry((attempt) => attempt + 1);
            }}>
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
