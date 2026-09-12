import { useCallback, useRef } from "react";

export function useSingleFlightGuard() {
  const inFlightRef = useRef(false);

  const tryStart = useCallback(() => {
    if (inFlightRef.current) {
      return false;
    }
    inFlightRef.current = true;
    return true;
  }, []);

  const finish = useCallback(() => {
    inFlightRef.current = false;
  }, []);

  return { tryStart, finish };
}
