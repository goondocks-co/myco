export type ReleaseTargetName = 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64' | 'windows-x64' | 'windows-arm64';
export interface ReleaseTarget {
  readonly name: ReleaseTargetName;
  readonly platform: 'darwin' | 'linux' | 'win32';
  readonly arch: 'arm64' | 'x64';
  readonly label: string;
  readonly native: boolean;
}
export const RELEASE_TARGETS: readonly ReleaseTarget[];
export function releaseTarget(name: string): ReleaseTarget | undefined;
export function hostReleaseTarget(platform?: string, arch?: string): ReleaseTarget | undefined;
export function binaryFileName(target: ReleaseTarget): string;
export function releaseAssetName(target: ReleaseTarget): string;
