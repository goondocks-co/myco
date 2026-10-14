import type { SetupProgress } from '../features/today/wire';

const HIDDEN_KEY = 'myco:get-started:hidden';

export function readHidden(): boolean {
  try { return localStorage.getItem(HIDDEN_KEY) === 'yes'; } catch { return false; }
}

export function rememberHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(HIDDEN_KEY, 'yes');
    else localStorage.removeItem(HIDDEN_KEY);
  } catch {
    // Storage disabled: dismissal lasts only for this visit.
  }
}

/** The viewer's observed steps; members connect a project through their own live session. */
export function setupChecks(progress: SetupProgress | undefined, admin: boolean): Record<string, boolean> {
  const machine = (progress?.machines.signedIn ?? 0) > 0;
  return admin ? {
    owner: progress?.ownerLinked === true,
    'sign-in': progress?.signInWorking === true,
    machine,
    project: (progress?.projects ?? 0) > 0,
    capture: progress?.liveCapture === true,
    runner: (progress?.runnersReady ?? 0) > 0,
    work: progress?.workProduced === true,
  } : { machine, 'project-capture': progress?.liveCapture === true };
}

export function setupComplete(progress: SetupProgress | undefined, admin: boolean): boolean {
  return progress !== undefined && Object.values(setupChecks(progress, admin)).every(Boolean);
}
