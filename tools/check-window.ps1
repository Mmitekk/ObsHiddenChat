Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Check {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public struct RECT { public int L; public int T; public int R; public int B; }
}
"@
$procs = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
if (-not $procs) { Write-Output "NO WINDOW"; exit }
foreach ($p in $procs) {
  $r = New-Object Win32Check+RECT
  [Win32Check]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
  $vis = [Win32Check]::IsWindowVisible($p.MainWindowHandle)
  $min = [Win32Check]::IsIconic($p.MainWindowHandle)
  Write-Output ("hwnd=" + $p.MainWindowHandle + " visible=" + $vis + " minimized=" + $min + " rect=" + $r.L + "," + $r.T + " - " + $r.R + "," + $r.B)
}
