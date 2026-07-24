/*
 * Copyright 2026 Myco Contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { resolveWindowsNativeProfile } from '@myco/utils/windows-native-profile.js';
import { resolveWindowsLockRootFromProfile } from '@myco/utils/user-lock-root.js';

process.stdout.write(JSON.stringify({
  lockRoot: resolveWindowsLockRootFromProfile(resolveWindowsNativeProfile()),
}));
