import { useState, useEffect } from 'react';

/** Debounce delay for search inputs (milliseconds). */
const DEFAULT_DEBOUNCE_MS = 300;

/**
 * Returns a debounced version of the input value.
 * Updates after the specified delay of inactivity.
 */
export function useDebounce<T>(value: T, delayMs: number = DEFAULT_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
