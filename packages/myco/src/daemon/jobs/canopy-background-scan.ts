import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { MS_PER_SECOND } from '@myco/constants.js';
import type { CanopyDeltaScanRunner } from './canopy-delta-scan.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { DaemonLogger } from '../logger.js';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;

export interface BackgroundScanContext {
  liveConfig: { current: MycoConfig };
  delta: CanopyDeltaScanRunner;
  logger: DaemonLogger;
}

/**
 * Periodic background driver: every PowerManager tick checks whether the
 * configured background period has elapsed since the last delta run, and
 * triggers one if so. The delta runner already debounces, so even if this
 * fires too eagerly the actual scan is gated.
 */
export class CanopyBackgroundScan {
  private lastDispatchedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly ctx: BackgroundScanContext) {}

  /** PowerManager job entry point. */
  async tick(): Promise<void> {
    const cfg = this.ctx.liveConfig.current.canopy.refresh;
    if (!cfg.background_enabled) return;
    const periodSeconds = parseDuration(cfg.background_period);
    if (periodSeconds <= 0) return;
    const now = Date.now();
    if (now - this.lastDispatchedAt < periodSeconds * MS_PER_SECOND) return;
    this.lastDispatchedAt = now;
    try {
      await this.ctx.delta.run(now);
    } catch (err) {
      this.ctx.logger.error(LOG_KINDS.CANOPY_ERROR, 'Canopy background scan dispatch failed', {
        error: (err as Error).message,
      });
    }
  }
}

/**
 * Parse a humanised duration of the form `<n><unit>` where unit is one of
 * `s | m | h | d`. Falls back to seconds when no unit is present. Returns 0
 * for inputs that fail to parse so callers can treat that as "disabled."
 */
export function parseDuration(input: string): number {
  const m = input.trim().match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/i);
  if (!m) return 0;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value) || value < 0) return 0;
  switch (m[2].toLowerCase()) {
    case 'm':
      return Math.round(value * SECONDS_PER_MINUTE);
    case 'h':
      return Math.round(value * SECONDS_PER_HOUR);
    case 'd':
      return Math.round(value * SECONDS_PER_DAY);
    case 's':
    case '':
    default:
      return Math.round(value);
  }
}
