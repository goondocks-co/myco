import { deltaScan } from '@myco/canopy/scanner/delta-scan.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { CanopyJobContext } from './canopy-scan.js';

/** Coalesce delta-scan triggers fired within this window into one run. */
export const CANOPY_DELTA_DEBOUNCE_MS = 30_000;

/**
 * Process-local debouncer for the delta scan. Multiple session-start hooks
 * landing within 30 s collapse to a single walk; the unused triggers are
 * dropped silently because the work they would do has already been done.
 */
export class CanopyDeltaScanRunner {
  // Sentinel so the first call always proceeds regardless of injected clock.
  private lastRunAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly ctx: CanopyJobContext) {}

  /**
   * Run a delta scan unless one ran within the debounce window or one is
   * already in flight. Both gates are necessary: the time gate handles the
   * "two session-start hooks back-to-back" case; the in-flight gate handles
   * the "background tick fires while session-start is still running" case.
   *
   * The supplied `now` is also used to stamp `lastRunAt` so a single
   * monotonic clock source drives both reads and writes — important for
   * tests that inject a deterministic clock.
   */
  async run(now: number = Date.now()): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (now - this.lastRunAt < CANOPY_DELTA_DEBOUNCE_MS) return;
    this.inFlight = this.execute().finally(() => {
      this.lastRunAt = now;
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async execute(): Promise<void> {
    const patterns = this.ctx.liveConfig.current.canopy.exclude.patterns;
    try {
      const result = deltaScan({
        db: this.ctx.db,
        projectId: this.ctx.projectId,
        machineId: this.ctx.machineId,
        projectRoot: this.ctx.projectRoot,
        excludePatterns: patterns,
      });
      this.ctx.logger.info(LOG_KINDS.CANOPY_SCAN, 'Canopy delta scan complete', {
        ...result,
      });
    } catch (err) {
      this.ctx.logger.error(LOG_KINDS.CANOPY_ERROR, 'Canopy delta scan failed', {
        error: (err as Error).message,
      });
    }
  }
}
