import { Link } from "react-router-dom";

import { Wordmark } from "../components/AppShell";
import { Button } from "../components/ui";

export default function NotFound() {
  return (
    <div className="grid min-h-full place-items-center bg-canvas px-4">
      <div className="flex max-w-sm flex-col items-center text-center">
        <Wordmark />
        <p className="mt-8 text-[11px] font-medium uppercase tracking-wide text-muted">404</p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-ink">Page not found</h1>
        <p className="mt-2 text-[13px] text-muted">
          That address does not exist. It may have been a link from an older build.
        </p>
        <Link to="/" className="mt-6">
          <Button variant="secondary">Back to the home page</Button>
        </Link>
      </div>
    </div>
  );
}
