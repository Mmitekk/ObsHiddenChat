param([string]$Out = "F:\z.ai\Custom\obs-hidden-chat\tools\screen2.png")
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Cap {
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int x1, int y1, int rop);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
}
"@
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$w = $b.Width; $h = $b.Height
$screenDC = [Cap]::GetDC([IntPtr]::Zero)
$memDC = [Cap]::CreateCompatibleDC($screenDC)
$hbm = [Cap]::CreateCompatibleBitmap($screenDC, $w, $h)
$old = [Cap]::SelectObject($memDC, $hbm)
$rop = 0x00CC0020 -bor 0x40000000   # SRCCOPY | CAPTUREBLT (включает layered-окна)
[Cap]::BitBlt($memDC, 0, 0, $w, $h, $screenDC, 0, 0, $rop) | Out-Null
$img = [System.Drawing.Image]::FromHbitmap($hbm)
$img.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
[Cap]::SelectObject($memDC, $old) | Out-Null
[Cap]::DeleteObject($hbm) | Out-Null
[Cap]::DeleteDC($memDC) | Out-Null
[Cap]::ReleaseDC([IntPtr]::Zero, $screenDC) | Out-Null
$img.Dispose()
Write-Output "saved $Out"
