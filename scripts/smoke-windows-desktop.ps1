param(
  [Parameter(Mandatory = $true)]
  [string]$Executable,
  [switch]$ElectronSmoke
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
  throw "Desktop executable is missing: $Executable"
}

function Get-PeSubsystem([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
    throw "Not a valid PE executable: $Path"
  }
  $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
  $signature = [Text.Encoding]::ASCII.GetString($bytes, $peOffset, 4)
  if ($signature -ne "PE`0`0") {
    throw "Invalid PE signature: $Path"
  }
  return [BitConverter]::ToUInt16($bytes, $peOffset + 24 + 68)
}

if ((Get-PeSubsystem $Executable) -ne 2) {
  throw 'Dimo must use IMAGE_SUBSYSTEM_WINDOWS_GUI and must not allocate a console.'
}

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DimoWindowInspector {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int maxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    public static uint[] ConsoleWindowOwners() {
        var owners = new List<uint>();
        EnumWindows((window, _) => {
            var name = new StringBuilder(256);
            GetClassName(window, name, name.Capacity);
            if (name.ToString() == "ConsoleWindowClass") {
                uint processId;
                GetWindowThreadProcessId(window, out processId);
                owners.Add(processId);
            }
            return true;
        }, IntPtr.Zero);
        return owners.ToArray();
    }
}
'@

function Test-DescendsFrom([uint32]$ProcessId, [uint32]$AncestorId) {
  $visited = @{}
  $current = $ProcessId
  while ($current -ne 0 -and -not $visited.ContainsKey($current)) {
    if ($current -eq $AncestorId) {
      return $true
    }
    $visited[$current] = $true
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction SilentlyContinue
    if ($null -eq $process) {
      return $false
    }
    $current = [uint32]$process.ParentProcessId
  }
  return $false
}

$prevSmoke = $env:DIMO_ELECTRON_SMOKE
$prevMulti = $env:DIMO_ALLOW_MULTI_INSTANCE
$prevDataDir = $env:DIMO_DATA_DIR
$prevRunAsNode = $env:ELECTRON_RUN_AS_NODE
$tempDataDir = $null

if ($ElectronSmoke) {
  $tempDataDir = Join-Path ([IO.Path]::GetTempPath()) ("dimo-win-smoke-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tempDataDir -Force | Out-Null
  $env:DIMO_ELECTRON_SMOKE = '1'
  $env:DIMO_ALLOW_MULTI_INSTANCE = '1'
  $env:DIMO_DATA_DIR = $tempDataDir
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}

$process = Start-Process -FilePath $Executable -PassThru
try {
  if ($ElectronSmoke) {
    $deadline = (Get-Date).AddSeconds(45)
    while (-not $process.HasExited -and (Get-Date) -lt $deadline) {
      $consoleOwners = [DimoWindowInspector]::ConsoleWindowOwners()
      foreach ($owner in $consoleOwners) {
        if (Test-DescendsFrom $owner ([uint32]$process.Id)) {
          throw "Dimo spawned a visible console window owned by process $owner."
        }
      }
      Start-Sleep -Milliseconds 300
    }
    if (-not $process.HasExited) {
      throw 'Dimo Electron smoke test did not complete within 45 seconds.'
    }
    if ($process.ExitCode -ne 0) {
      throw "Dimo Electron smoke test failed with exit code $($process.ExitCode)."
    }
    Start-Sleep -Milliseconds 500
    $orphans = Get-CimInstance Win32_Process -Filter "Name = 'dimo-server.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ParentProcessId -eq $process.Id }
    if ($orphans) {
      throw "Orphan dimo-server.exe process remained after Electron smoke exit."
    }
  } else {
    Start-Sleep -Seconds 8
    if ($process.HasExited) {
      throw "Dimo exited during the Windows startup smoke test with code $($process.ExitCode)."
    }

    $consoleOwners = [DimoWindowInspector]::ConsoleWindowOwners()
    foreach ($owner in $consoleOwners) {
      if (Test-DescendsFrom $owner ([uint32]$process.Id)) {
        throw "Dimo spawned a visible console window owned by process $owner."
      }
    }
  }
}
finally {
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    $process.WaitForExit()
  }
  if ($ElectronSmoke) {
    if ($null -eq $prevSmoke) { Remove-Item Env:DIMO_ELECTRON_SMOKE -ErrorAction SilentlyContinue } else { $env:DIMO_ELECTRON_SMOKE = $prevSmoke }
    if ($null -eq $prevMulti) { Remove-Item Env:DIMO_ALLOW_MULTI_INSTANCE -ErrorAction SilentlyContinue } else { $env:DIMO_ALLOW_MULTI_INSTANCE = $prevMulti }
    if ($null -eq $prevDataDir) { Remove-Item Env:DIMO_DATA_DIR -ErrorAction SilentlyContinue } else { $env:DIMO_DATA_DIR = $prevDataDir }
    if ($null -ne $prevRunAsNode) { $env:ELECTRON_RUN_AS_NODE = $prevRunAsNode }
    if ($tempDataDir -and (Test-Path $tempDataDir)) {
      Remove-Item -LiteralPath $tempDataDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
