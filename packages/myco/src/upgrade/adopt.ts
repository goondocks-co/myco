/** Legacy daemon adoption parameters and shutdown request. */
import fs from 'node:fs';

import { MYCO_GLOBAL_DIR } from '../constants/update.js';
import { spawnApplyUpgrade } from './spawn.js';
import type { ApplyAdoptParams } from './spawn.js';

export type { ApplyAdoptParams };

interface AdoptBaseOpts {
  targetVersion: string;
  prevVersion: string;
  /** Myco home directory. */
  home: string;
  platform: NodeJS.Platform;
  /** On win32, the real `%LOCALAPPDATA%` value. Ignored on POSIX. */
  localAppData?: string;
  /** Canonical daemon port. */
  daemonPort: number;
  /** Service label or null when not service-managed. */
  serviceManagedLabel?: string | null;
  mycoBinary: string;
  projectRoot: string;
  maxHealthAttempts?: number;
  /** Delay between /health polls (ms). Default 2000. */
  healthIntervalMs?: number;
  inProgressSentinelPath?: string | null;
  keepVersions?: number;
}

export interface InitiateAdoptFromDaemon extends AdoptBaseOpts {
  source: 'daemon';
}

export type InitiateAdoptOpts = InitiateAdoptFromDaemon;

function buildAdoptParams(opts: AdoptBaseOpts): ApplyAdoptParams {
  return {
    kind: 'adopt',
    targetVersion: opts.targetVersion,
    prevVersion: opts.prevVersion,
    home: opts.home,
    platform: opts.platform,
    localAppData: opts.localAppData,
    daemonPort: opts.daemonPort,
    serviceManagedLabel: opts.serviceManagedLabel ?? null,
    mycoBinary: opts.mycoBinary,
    projectRoot: opts.projectRoot,
    maxHealthAttempts: opts.maxHealthAttempts ?? 30,
    healthIntervalMs: opts.healthIntervalMs ?? 2000,
    inProgressSentinelPath: opts.inProgressSentinelPath ?? null,
    keepVersions: opts.keepVersions ?? 3,
  };
}

function spawnAdoptDetached(params: ApplyAdoptParams): void {
  fs.mkdirSync(MYCO_GLOBAL_DIR, { recursive: true });
  spawnApplyUpgrade('myco-adopt', params);
}

export async function initiateAdopt(opts: InitiateAdoptOpts): Promise<void> {
  const params = buildAdoptParams(opts);
  spawnAdoptDetached(params);
  try {
    const { requestCooperativeShutdown } = await import('../service/cooperative-shutdown.js');
    await requestCooperativeShutdown(opts.daemonPort);
  } catch (error) {
    console.error(`Myco cooperative shutdown request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
