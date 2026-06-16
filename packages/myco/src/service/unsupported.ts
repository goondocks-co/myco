import type {
  InstallOptions,
  InstallResult,
  ServiceManager,
  ServiceSpec,
  ServiceStatus,
} from './types.js';

export class UnsupportedServiceManager implements ServiceManager {
  readonly supported = false;
  readonly platformName: string;

  constructor(platform: string) {
    this.platformName = `unsupported (${platform})`;
  }

  private fail(): never {
    throw new Error(`Service management not yet supported on ${this.platformName}. Run \`myco daemon\` manually or wait for a future release.`);
  }

  async isInstalled(_label: string): Promise<boolean> { return false; }
  async install(_spec: ServiceSpec, _opts?: InstallOptions): Promise<InstallResult> { this.fail(); }
  async uninstall(_label: string): Promise<void> { this.fail(); }
  async start(_label: string): Promise<void> { this.fail(); }
  async stop(_label: string): Promise<void> { this.fail(); }
  async restart(_label: string): Promise<void> { this.fail(); }
  restartShellCommand(_label: string): string { this.fail(); }

  async status(_label: string): Promise<ServiceStatus> {
    return { installed: false, running: false, pid: null, lastExitCode: null, unitPath: null };
  }

  isManagedDaemon(_label: string, _status: ServiceStatus, _myPid: number): boolean {
    return false;
  }
}
