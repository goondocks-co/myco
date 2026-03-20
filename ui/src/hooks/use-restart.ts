import { useState, useCallback, useRef } from 'react';
import { postJson } from '../lib/api';

const RESTART_POLL_INTERVAL_MS = 500;
const RESTART_TIMEOUT_MS = 30_000;

interface RestartResponse {
  status: string;
  message?: string;
}

export function useRestart() {
  const [isRestarting, setIsRestarting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const restart = useCallback(async (force = false) => {
    setIsRestarting(true);
    try {
      const result = await postJson<RestartResponse>('/restart', { force });
      if (result.status === 'busy') {
        setIsRestarting(false);
        return result;
      }
      // Poll health until daemon comes back.
      // The /health endpoint lives outside /api, so use raw fetch.
      const deadline = Date.now() + RESTART_TIMEOUT_MS;
      abortRef.current = new AbortController();
      await new Promise<void>((resolve, reject) => {
        const check = async () => {
          if (Date.now() > deadline) {
            reject(new Error('Restart timeout'));
            return;
          }
          try {
            const res = await fetch('/health', { signal: abortRef.current!.signal });
            if (res.ok) {
              resolve();
              return;
            }
            setTimeout(check, RESTART_POLL_INTERVAL_MS);
          } catch {
            setTimeout(check, RESTART_POLL_INTERVAL_MS);
          }
        };
        setTimeout(check, RESTART_POLL_INTERVAL_MS);
      });
      window.location.reload();
    } catch (error) {
      setIsRestarting(false);
      throw error;
    }
  }, []);

  return { restart, isRestarting };
}
