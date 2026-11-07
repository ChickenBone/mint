import { useCallback, useEffect, useRef, useState } from "react";

export function useSeekPreview(scope: unknown, occurrenceId: string | undefined, commit: (value: number) => void) {
  const [preview, setPreview] = useState<{ scope: unknown; occurrenceId?: string; value: number } | null>(null);
  const current = useRef({ scope, occurrenceId, active: true });
  useEffect(() => {
    current.current = { scope, occurrenceId, active: true };
    return () => { current.current.active = false; };
  }, [scope, occurrenceId]);
  const change = useCallback((value: number) => {
    if (!current.current.active || current.current.scope !== scope || current.current.occurrenceId !== occurrenceId) return;
    setPreview({ scope, occurrenceId, value });
  }, [scope, occurrenceId]);
  const complete = useCallback((value: number) => {
    if (!current.current.active || current.current.scope !== scope || current.current.occurrenceId !== occurrenceId) return;
    setPreview(null);
    commit(value);
  }, [scope, occurrenceId, commit]);
  return { value: preview && preview.scope === scope && preview.occurrenceId === occurrenceId ? preview.value : null, change, complete };
}
