import { TEST_TEMP_ROOT } from './temp-root.js';
import './temp-subprocesses.js';
import os from 'node:os';
import { sandboxTestHome } from '../../scripts/test-environment.mjs';

export const SANDBOX_HOME = sandboxTestHome(TEST_TEMP_ROOT);
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
