/**
 * One-time "new project is capture-only" notice.
 *
 * `ensureProjectVault`'s cold path runs in short-lived hook client
 * processes with no notifications DB, so it only writes a marker file
 * (`vault/provision.ts` — `CAPTURE_ONLY_NOTICE_MARKER`), and only when it
 * seeded a fresh capture-only project. This daemon-side sweep finds the
 * marker on registered projects, emits the drawer notice pointing at
 * Grove management, and then deletes the marker. The marker file is the
 * durable dedup across daemon restarts; it is consumed only after the
 * notification landed (or was deliberately suppressed), so a transient
 * emit failure retries on a later sweep instead of losing the notice.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CAPTURE_ONLY_NOTICE_MARKER } from '../vault/provision.js';
import { capabilitiesPanelLink, describeCaptureOnly, isCaptureOnly } from '../config/capabilities.js';
import { notify } from './notify.js';
import type { MycoConfig } from '../config/schema.js';
import type { GroveProjectId } from '../grove/ids.js';

export function captureOnlyNoticeMarkerPath(vaultDir: string): string {
  return path.join(vaultDir, CAPTURE_ONLY_NOTICE_MARKER);
}

export type CaptureOnlyNoticeSweepResult = 'none' | 'notified' | 'cleared' | 'deferred';

function tryConsumeMarker(markerPath: string, warn?: (message: string) => void): void {
  try {
    fs.rmSync(markerPath, { force: true });
  } catch (err) {
    // force suppresses only ENOENT; a permission error leaves the marker
    // for the next sweep. Surfaced to the caller's log rather than thrown
    // so one unwritable vault can't fail the whole sweep.
    warn?.(`capture-only notice marker could not be removed (${markerPath}): ${(err as Error).message}`);
  }
}

/**
 * Consume a pending capture-only notice marker for one project.
 *
 *   - 'none': no marker.
 *   - 'cleared': marker consumed without a notice (project already
 *     promoted, or notifications for it are turned off).
 *   - 'notified': notice emitted, marker consumed.
 *   - 'deferred': emit did not land (transient DB/config failure, or the
 *     provisioner's mid-write window) — the marker stays for a later sweep.
 */
export function sweepCaptureOnlyNotice(input: {
  vaultDir: string;
  projectId: GroveProjectId;
  projectName: string;
  config: MycoConfig | null;
  warn?: (message: string) => void;
}): CaptureOnlyNoticeSweepResult {
  const markerPath = captureOnlyNoticeMarkerPath(input.vaultDir);
  if (!fs.existsSync(markerPath)) return 'none';

  if (input.config && !isCaptureOnly(input.config)) {
    tryConsumeMarker(markerPath, input.warn);
    return 'cleared';
  }

  // notify() returns null for BOTH deliberate suppression and internal
  // failure. Suppression is checked here so it consumes the marker;
  // a null from notify() after this point is a failure worth retrying.
  const notifications = input.config?.notifications;
  if (notifications && (!notifications.enabled || notifications.domains?.projects?.enabled === false)) {
    tryConsumeMarker(markerPath, input.warn);
    return 'cleared';
  }

  const id = notify(
    input.vaultDir,
    {
      domain: 'projects',
      type: 'project.capture_only',
      level: 'info',
      title: `${input.projectName} is being captured`,
      message:
        `${describeCaptureOnly()} Turn them on in Grove management, or leave `
        + 'them off if capture is all you want here.',
      link: capabilitiesPanelLink(input.projectId),
    },
    input.config ?? undefined,
    { projectId: input.projectId },
  );

  if (!id) return 'deferred';
  tryConsumeMarker(markerPath, input.warn);
  return 'notified';
}
