import { dlopen, FFIType, ptr } from 'bun:ffi';
import { useTestProcessIdentityReader } from '../../scripts/test-process-tree.mjs';

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const ERROR_INVALID_PARAMETER = 87;

if (process.platform === 'win32') {
  const api = dlopen('kernel32.dll', {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
    GetProcessTimes: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  }).symbols;
  useTestProcessIdentityReader((pid) => {
    const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (!handle) {
      const code = api.GetLastError();
      if (code === ERROR_INVALID_PARAMETER) return null;
      throw new Error(`OpenProcess failed for test PID ${pid}: ${code}`);
    }
    try {
      const times = new BigUint64Array(4);
      if (api.GetProcessTimes(handle, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24)) === 0) {
        throw new Error(`GetProcessTimes failed for test PID ${pid}: ${api.GetLastError()}`);
      }
      return times[0]!.toString();
    } finally {
      if (api.CloseHandle(handle) === 0) throw new Error(`CloseHandle failed for test PID ${pid}: ${api.GetLastError()}`);
    }
  });
}
