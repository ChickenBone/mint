import { useCallback, useEffect, useState } from "react";

export function useResource<T>(load: (signal: AbortSignal) => Promise<T>, keys: readonly unknown[]) {
  const [result, setResult] = useState<{ keys: readonly unknown[]; data: T | null; error: string | null } | null>(null);
  const [revision, setRevision] = useState(0);
  const requestKeys = [...keys, revision];
  const current = result && requestKeys.length === result.keys.length && requestKeys.every((key, index) => Object.is(key, result.keys[index]));
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then((result) => {
      if (!controller.signal.aborted) setResult({ keys: requestKeys, data: result, error: null });
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setResult({ keys: requestKeys, data: null, error: reason instanceof Error ? reason.message : "Music could not load. Try again." });
    });
    return () => controller.abort();
    // Callers provide the stable values that determine their request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...keys, revision]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return { data: current ? result.data : null, error: current ? result.error : null, loading: !current, reload };
}
