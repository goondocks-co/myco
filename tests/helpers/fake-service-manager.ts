/**
 * Shared ServiceManager fakes for daemon/service tests.
 *
 * Five test files used to define near-identical fakes of the ServiceManager
 * interface (with slight per-test tracking shapes). Lifting them here gives
 * us a single, fully-configurable double that:
 *
 *  - tracks every method call (`installCalls`, `restartCalls`, etc.) so tests
 *    can assert on label routing without re-implementing the bookkeeping;
 *  - opts every method into "track-only" semantics (no real launchctl /
 *    systemctl side effects);
 *  - exposes `installed` / `statuses` as mutable handles so tests can drive
 *    the scenarios they need.
 *
 * Use `new FakeServiceManager()` for the common case. Use
 * `noServiceManager()` when the test wants the "platform supports services
 * but nothing is installed" wedge — exercising the legacy raw-spawn path.
 */

import type { ServiceManager, ServiceSpec, ServiceStatus } from '@myco/service/types';

export interface FakeServiceManagerOptions {
  /** Whether the platform appears to support services at all. Default true. */
  supported?: boolean;
  /** Reported platformName. Default 'fake'. */
  platformName?: string;
  /** Seed isInstalled() to true for a single label. */
  preInstalled?: boolean | string;
}

/**
 * Fully-configurable, track-only fake. Tests mutate `installed`/`statuses`
 * directly to drive scenarios, and read `restartCalls`/`startCalls`/etc. to
 * verify which labels the production code routed through.
 */
export class FakeServiceManager implements ServiceManager {
  readonly supported: boolean;
  readonly platformName: string;

  /** Labels currently "installed". */
  installed = new Set<string>();
  /** Label → status snapshot returned by status(). */
  statuses = new Map<string, ServiceStatus>();
  /** Optional per-label shell command for restartShellCommand. */
  restartShellCommands = new Map<string, string>();

  installCalls: ServiceSpec[] = [];
  uninstallCalls: string[] = [];
  startCalls: string[] = [];
  stopCalls: string[] = [];
  restartCalls: string[] = [];
  statusCalls = 0;

  constructor(opts: FakeServiceManagerOptions = {}) {
    this.supported = opts.supported ?? true;
    this.platformName = opts.platformName ?? 'fake';
    if (opts.preInstalled === true) {
      // Backward-compat: self-install.test.ts seeded `installed = true` as a
      // boolean and queried isInstalled() with whatever label happened to come
      // in. Treat boolean-true as "every label looks installed".
      this.installed = new Set();
      this._preInstalledAll = true;
    } else if (typeof opts.preInstalled === 'string') {
      this.installed.add(opts.preInstalled);
    }
  }

  private _preInstalledAll = false;

  async isInstalled(label: string): Promise<boolean> {
    if (this._preInstalledAll) return true;
    return this.installed.has(label);
  }

  async install(spec: ServiceSpec): Promise<void> {
    this.installCalls.push(spec);
    this.installed.add(spec.label);
    if (this._preInstalledAll) this._preInstalledAll = true;
  }

  async uninstall(label: string): Promise<void> {
    this.uninstallCalls.push(label);
    this.installed.delete(label);
    if (this._preInstalledAll) this._preInstalledAll = false;
  }

  async start(label: string): Promise<void> { this.startCalls.push(label); }
  async stop(label: string): Promise<void> { this.stopCalls.push(label); }
  async restart(label: string): Promise<void> { this.restartCalls.push(label); }

  restartShellCommand(label: string): string {
    return this.restartShellCommands.get(label) ?? `fake-restart ${label}`;
  }

  async status(label: string): Promise<ServiceStatus> {
    this.statusCalls++;
    if (this.statuses.has(label)) return this.statuses.get(label)!;
    if (this._preInstalledAll) {
      return { installed: true, running: true, pid: 1234, lastExitCode: 0, unitPath: '/fake/unit' };
    }
    return { installed: false, running: false, pid: null, lastExitCode: null, unitPath: null };
  }
}

/**
 * Convenience factory for the "platform supports services but no daemon is
 * installed" scenario. Tests that exercise the legacy raw-spawn path use
 * this as a wedge — restart()/spawnDaemon() take the no-service branch
 * regardless of which symbiont label is queried.
 */
export function noServiceManager(): ServiceManager {
  return new FakeServiceManager();
}
