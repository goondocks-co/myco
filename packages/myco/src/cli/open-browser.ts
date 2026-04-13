/**
 * Open a URL in the user's default browser.
 * Fire-and-forget -- failures are silently ignored (e.g. headless/SSH).
 *
 * Note: uses child_process.exec (not execFile) because Windows `start`
 * is a cmd.exe shell builtin, not a standalone executable. The URL is
 * always internally constructed (never user input), so shell injection
 * is not a concern here.
 */
import { exec } from 'node:child_process';

export function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"`
    : process.platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`;

  exec(cmd, () => {
    // Intentionally swallowed -- printed URL is the fallback
  });
}
