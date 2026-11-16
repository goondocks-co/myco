export interface DockerInstruction {
  kind: 'copy' | 'run';
  from?: string;
  sources?: string[];
  destination?: string;
  intoDirectory?: boolean;
  command?: string;
  workdir: string;
}
export function dockerStages(text: string): Array<{ name: string; workdir: string; instructions: DockerInstruction[] }>;
export function imageInputs(input: {
  context: string;
  dockerfile: string;
  scratch: string;
  run: (command: string, args: string[], options: { cwd: string; shell?: boolean }) => Promise<string>;
  mirrorModules: (source: string, destination: string, packagesRoot: string) => void;
}): Promise<string[]>;
