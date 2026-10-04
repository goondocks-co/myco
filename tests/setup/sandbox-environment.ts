import './temp-root.js';
import './temp-subprocesses.js';
import { afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxPath } from '../../scripts/test-environment.mjs';

export const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'h-'));
const remove = fs.rmSync.bind(fs);
const userInfo = os.userInfo.bind(os);

os.homedir = () => SANDBOX_HOME;
function sandboxUserInfo(options?: os.UserInfoOptionsWithStringEncoding): os.UserInfo<string>;
function sandboxUserInfo(options: os.UserInfoOptionsWithBufferEncoding): os.UserInfo<Buffer<ArrayBuffer>>;
function sandboxUserInfo(options: os.UserInfoOptions): os.UserInfo<string | Buffer<ArrayBuffer>>;
function sandboxUserInfo(options: os.UserInfoOptions = {}): os.UserInfo<string | Buffer<ArrayBuffer>> {
  return {
    ...userInfo(options),
    homedir: options.encoding === 'buffer' ? Buffer.from(SANDBOX_HOME) : SANDBOX_HOME,
  };
}
os.userInfo = sandboxUserInfo;
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;
process.env.CODEX_HOME = path.join(SANDBOX_HOME, '.codex');
process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_HOME, '.claude');
process.env.MYCO_HOME ??= path.join(SANDBOX_HOME, '.myco');

process.env.PATH = sandboxPath(SANDBOX_HOME);

const cleanup = () => remove(SANDBOX_HOME, { recursive: true, force: true });
afterAll(cleanup);
process.on('exit', cleanup);
