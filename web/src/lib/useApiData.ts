import { useCallback, useEffect, useState } from "react";

import { errorMessage } from "../api/client";

/**
 * Loads data from the API and tracks its lifecycle.
 *
 * `deps` controls when the load re-runs, exactly like a useEffect dep array.
 * A cancelled flag means a fast-changing filter (clicking through dates) can
 * never let a slow earlier response overwrite a newer one.
 */
export function useApiData<T>(deps: unknown[], load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    load()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { data, loading, error, reload, setData };
}
