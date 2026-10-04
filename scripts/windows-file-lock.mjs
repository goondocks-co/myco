import { spawnSync } from 'node:child_process';

export function describeWindowsFileLock(file) {
  const literal = `'${file.replaceAll("'", "''")}'`;
  const command = `$ErrorActionPreference = 'Stop'; Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MycoTestFileLock {
  [StructLayout(LayoutKind.Sequential)] public struct Unique {
    public int pid;
    public System.Runtime.InteropServices.ComTypes.FILETIME time;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Info {
    public Unique process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string app;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string service;
    public uint type, status, session;
    [MarshalAs(UnmanagedType.Bool)] public bool restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint session, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint session, uint count, string[] files, uint apps, IntPtr processes, uint services, IntPtr names);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] Info[] list, out uint reasons);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
  static void Check(int status) { if(status != 0) throw new System.ComponentModel.Win32Exception(status); }
  public static Info[] Owners(string file) {
    uint session; Check(RmStartSession(out session, 0, new StringBuilder(33)));
    try {
      Check(RmRegisterResources(session, 1, new string[]{file}, 0, IntPtr.Zero, 0, IntPtr.Zero));
      uint needed, count=0, reasons;
      int status=RmGetList(session, out needed, ref count, null, out reasons);
      if(status == 0) return new Info[0];
      if(status != 234) Check(status);
      count=needed;
      var list=new Info[count];
      Check(RmGetList(session, out needed, ref count, list, out reasons));
      Array.Resize(ref list, (int)count);
      return list;
    } finally { Check(RmEndSession(session)); }
  }
}
'@; [MycoTestFileLock]::Owners(${literal}) | ForEach-Object {
  $owner = [System.Diagnostics.Process]::GetProcessById($_.process.pid);
  try { 'PID=' + $_.process.pid + ' app=' + $_.app + ' name=' + $owner.ProcessName + ' executable=' + $owner.MainModule.FileName + ' started=' + $owner.StartTime.ToUniversalTime().ToString('o') }
  finally { $owner.Dispose() }
};`;
  const result = spawnSync(process.env.MYCO_TEST_PWSH_EXECUTABLE ?? 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 15_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`File-lock inspection failed: ${result.stderr}`);
  return result.stdout.trim() || 'No user process reported by Restart Manager';
}
