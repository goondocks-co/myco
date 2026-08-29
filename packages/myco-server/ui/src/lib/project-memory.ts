const LAST_PROJECT_KEY = 'myco-last-project';

/** The project this viewer last opened, or null. Storage may be unavailable; that reads as null. */
export function readLastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function rememberProject(projectId: string): void {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, projectId);
  } catch {
    // Storage disabled: the next visit lands on the Projects page instead.
  }
}

export function forgetProject(): void {
  try {
    localStorage.removeItem(LAST_PROJECT_KEY);
  } catch {
    // Nothing to forget when storage is disabled.
  }
}
