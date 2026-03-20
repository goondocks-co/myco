import { useQuery, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query';
import { usePowerState, POWER_MULTIPLIERS, type PowerState } from '../providers/power';

export type PollCategory = 'heartbeat' | 'standard' | 'realtime';

/** Maximum poll interval for heartbeat in hidden state */
const HEARTBEAT_HIDDEN_CAP_MS = 60_000;
/** Maximum poll interval for heartbeat in deep_sleep state */
const HEARTBEAT_DEEP_SLEEP_CAP_MS = 30_000;

export interface UsePowerQueryOptions<T> extends Omit<UseQueryOptions<T>, 'refetchInterval'> {
  pollCategory: PollCategory;
  refetchInterval: number;
}

/**
 * Compute the effective poll interval based on power state and category.
 *
 * - heartbeat: always polls, capped in deep_sleep/hidden
 * - standard/realtime: multiplied rate in idle, stops in deep_sleep/hidden
 */
export function computePollInterval(
  baseMs: number,
  category: PollCategory,
  powerState: PowerState,
): number | false {
  if (category === 'heartbeat') {
    const multiplied = baseMs * POWER_MULTIPLIERS[powerState];
    if (powerState === 'hidden') {
      return Math.min(multiplied, HEARTBEAT_HIDDEN_CAP_MS);
    }
    if (powerState === 'deep_sleep') {
      return Math.min(multiplied, HEARTBEAT_DEEP_SLEEP_CAP_MS);
    }
    return multiplied;
  }

  // standard and realtime: stop polling in deep_sleep and hidden
  if (powerState === 'deep_sleep' || powerState === 'hidden') {
    return false;
  }

  return baseMs * POWER_MULTIPLIERS[powerState];
}

export function usePowerQuery<T>(options: UsePowerQueryOptions<T>): UseQueryResult<T> {
  const powerState = usePowerState();
  const { pollCategory, refetchInterval: baseInterval, ...queryOptions } = options;

  const effectiveInterval = computePollInterval(baseInterval, pollCategory, powerState);

  return useQuery({
    ...queryOptions,
    refetchInterval: effectiveInterval,
  } as UseQueryOptions<T>);
}
