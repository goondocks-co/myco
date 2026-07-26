import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { setClientActivity, pingDaemonAwake } from '../lib/client-activity';

export type PowerState = 'active' | 'idle' | 'deep_sleep' | 'hidden';

interface PowerContextValue {
  powerState: PowerState;
}

/** Milliseconds of inactivity before transitioning to idle */
const IDLE_THRESHOLD_MS = 60_000;
/** Milliseconds from idle start before transitioning to deep sleep */
const DEEP_SLEEP_THRESHOLD_MS = 300_000;
/** Debounce interval for activity events */
const ACTIVITY_DEBOUNCE_MS = 200;

/** Poll interval multipliers per power state */
export const POWER_MULTIPLIERS: Record<PowerState, number> = {
  active: 1,
  idle: 2,
  deep_sleep: 5,
  hidden: 10,
};

const ACTIVITY_EVENTS: Array<keyof DocumentEventMap> = [
  'mousemove',
  'mousedown',
  'keydown',
  'scroll',
  'touchstart',
];

const PowerContext = createContext<PowerContextValue | undefined>(undefined);

export function PowerProvider({ children }: { children: ReactNode }) {
  const [powerState, setPowerState] = useState<PowerState>('active');
  const previousStateRef = useRef<PowerState>('active');

  // Publish to the fetch layer, which is a plain module and cannot use hooks.
  //
  // On the idle→active edge, also ping the daemon directly. Coming back means
  // it may be deep-asleep with its tick timer stopped, and nothing pull-based
  // can revive it; this one request carries the `active` class and wakes it
  // immediately, rather than waiting for whichever poll happens to fire next.
  // Deliberately a bare fetch and not a react-query refetch: this provider
  // sits above the QueryClientProvider in some trees and is rendered without
  // one in tests, so it must not depend on a query client existing.
  useEffect(() => {
    setClientActivity(powerState);
    const previous = previousStateRef.current;
    previousStateRef.current = powerState;
    if (powerState === 'active' && previous !== 'active') {
      void pingDaemonAwake();
    }
  }, [powerState]);

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deepSleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityRef = useRef<number>(Date.now());

  const clearTimers = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (deepSleepTimerRef.current) {
      clearTimeout(deepSleepTimerRef.current);
      deepSleepTimerRef.current = null;
    }
  }, []);

  const startIdleTimer = useCallback(() => {
    clearTimers();

    idleTimerRef.current = setTimeout(() => {
      setPowerState('idle');

      deepSleepTimerRef.current = setTimeout(() => {
        setPowerState('deep_sleep');
      }, DEEP_SLEEP_THRESHOLD_MS - IDLE_THRESHOLD_MS);
    }, IDLE_THRESHOLD_MS);
  }, [clearTimers]);

  const onActivity = useCallback(() => {
    const now = Date.now();
    if (now - lastActivityRef.current < ACTIVITY_DEBOUNCE_MS) return;
    lastActivityRef.current = now;

    setPowerState('active');
    startIdleTimer();
  }, [startIdleTimer]);

  const onVisibilityChange = useCallback(() => {
    if (document.hidden) {
      clearTimers();
      setPowerState('hidden');
    } else {
      setPowerState('active');
      lastActivityRef.current = Date.now();
      startIdleTimer();
    }
  }, [clearTimers, startIdleTimer]);

  useEffect(() => {
    // Start the idle countdown on mount
    startIdleTimer();

    for (const event of ACTIVITY_EVENTS) {
      document.addEventListener(event, onActivity, { passive: true });
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearTimers();
      for (const event of ACTIVITY_EVENTS) {
        document.removeEventListener(event, onActivity);
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [onActivity, onVisibilityChange, startIdleTimer, clearTimers]);

  return (
    <PowerContext.Provider value={{ powerState }}>
      {children}
    </PowerContext.Provider>
  );
}

export function usePowerState(): PowerState {
  const ctx = useContext(PowerContext);
  if (!ctx) {
    throw new Error('usePowerState must be used within a PowerProvider');
  }
  return ctx.powerState;
}
