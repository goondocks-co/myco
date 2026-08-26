declare const process: { argv: string[]; cwd(): string; exit(code: number): never; stdout: { write(text: string): void } };
declare const Bun: { write(path: string | URL, data: string): Promise<number> };
interface ImportMeta { url: string }
