import { WindowsTaskServiceManager as PlatformWindowsTaskServiceManager, type WindowsManagerOptions } from '@myco/member/legacy-service/windows.js';
import { withExternalMcpContainment } from './daemon-termination.js';
export * from '@myco/member/legacy-service/windows.js';

export class WindowsTaskServiceManager extends PlatformWindowsTaskServiceManager {
  constructor(opts: WindowsManagerOptions = {}) {
    super({ ...opts, withExternalMcpContainment: opts.withExternalMcpContainment ?? withExternalMcpContainment });
  }
}
