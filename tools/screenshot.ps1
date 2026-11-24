param([string]$Out = "F:\z.ai\Custom\obs-hidden-chat\tools\screen.png")
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
# CAPTUREBLT: включать layered-окна (прозрачные окна Electron) в снимок
$op = [System.Drawing.CopyPixelOperation]([int][System.Drawing.CopyPixelOperation]::SourceCopy -bor 0x40000000)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $b.Size, $op)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output "saved $Out"
