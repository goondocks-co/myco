import os from 'node:os';
import { installFilesystemFence, installTestTempFence } from '../setup/filesystem-fence.js';
import { nativeLockRoots } from '../setup/native-lock-fence.js';

installFilesystemFence(os.userInfo().homedir, nativeLockRoots());
installTestTempFence(process.env.MYCO_TEST_RUN_ROOT!);
