export function signExecutable(options: {
  target: string;
  outfile: string;
  platform?: string;
  run?: (command: string, args: string[], options: { stdio: 'inherit' }) => {
    status: number | null;
    signal?: string | null;
    error?: Error;
  };
}): void;
