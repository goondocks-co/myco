export const PROMPT_FILE_CONTEXT_CHARS = 8_192;
export const PROMPT_FILE_OPENING_CHARS = 4_096;
export const PROMPT_FILE_READ_BUDGET_MS = 50;
export const PROMPT_FILE_READER_VERB = 'read-prompt-files';

export interface PromptFileInput {
  text: string;
  cwd: string;
  projectRoot?: string;
  roots?: string[];
  deadline: number;
  env?: NodeJS.ProcessEnv;
}
export interface PromptFileRead extends PromptFileInput { references: string[] }
