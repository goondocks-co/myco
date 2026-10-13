$ErrorActionPreference = 'Stop'
$jobType = Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class MycoProcessJob
{
    private const uint KillOnJobClose = 0x00002000;
    private const int ExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInfo
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref ExtendedLimitInfo information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static int ExtendedLimitInfoSize
    {
        get { return Marshal.SizeOf(typeof(ExtendedLimitInfo)); }
    }

    public static IntPtr CreateForCurrentProcess()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");

        var information = new ExtendedLimitInfo();
        information.BasicLimitInformation.LimitFlags = KillOnJobClose;
        uint size = (uint)Marshal.SizeOf(typeof(ExtendedLimitInfo));
        if (!SetInformationJobObject(job, ExtendedLimitInformation, ref information, size))
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new Win32Exception(error, "SetInformationJobObject failed");
        }

        using (Process current = Process.GetCurrentProcess())
        {
            if (!AssignProcessToJobObject(job, current.Handle))
            {
                int error = Marshal.GetLastWin32Error();
                CloseHandle(job);
                throw new Win32Exception(error, "AssignProcessToJobObject failed");
            }
        }
        return job;
    }

    public static void Close(IntPtr job)
    {
        if (job != IntPtr.Zero && !CloseHandle(job))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CloseHandle failed");
    }
}
'@ -PassThru
if ([MycoProcessJob]::ExtendedLimitInfoSize -ne 144) {
  throw "Unexpected Windows Job Object ABI size: $([MycoProcessJob]::ExtendedLimitInfoSize)"
}
$jobHandle = [MycoProcessJob]::CreateForCurrentProcess()
$executable = 'C:\Myco\myco.exe'
$arguments = @('daemon')
$workingDirectory = '__MYCO_HOME__'
$stdoutPath = 'out.log'
$stderrPath = 'err.log'
function Invoke-MycoProcess {
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $executable
  $startInfo.Arguments = $arguments -join ' '
  $startInfo.WorkingDirectory = $workingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.EnvironmentVariables['MYCO_HOME'] = '__MYCO_HOME__'
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  $stdout = [IO.File]::Open($stdoutPath, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
  $stderr = [IO.File]::Open($stderrPath, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
  try {
    if (-not $process.Start()) { throw 'Myco process did not start' }
    $stdoutCopy = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
    $stderrCopy = $process.StandardError.BaseStream.CopyToAsync($stderr)
    $process.WaitForExit()
    [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]] @($stdoutCopy, $stderrCopy))
    return $process.ExitCode
  } finally {
    $stdout.Dispose()
    $stderr.Dispose()
    $process.Dispose()
  }
}
try {
  $restarts = 0
  while ($true) {
    try {
      $exitCode = Invoke-MycoProcess
    } catch {
      [Console]::Error.WriteLine($_.Exception.ToString())
      $exitCode = 1
    }
    if ($exitCode -eq 0) { exit 0 }
    $restarts += 1
    if ($restarts -ge 10) { exit $exitCode }
    Start-Sleep -Seconds 10
  }
} finally {
  [MycoProcessJob]::Close($jobHandle)
}
