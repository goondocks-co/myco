export function signExecutable(options: {
  target: string;
  outfile: string;
  platform?: string;
  run?: (command: string, args: string[], options: { cwd: string; stdio: 'inherit'; timeout: number }) => {
    status: number | null;
    signal?: string | null;
    error?: Error;
  };
}): void;
