import os from 'node:os';
import { installFilesystemFence } from '../setup/filesystem-fence.js';
import { nativeLockRoots } from '../setup/native-lock-fence.js';

installFilesystemFence(os.userInfo().homedir, nativeLockRoots());
