$root = (Resolve-Path "$PSScriptRoot\..").Path
$desktop = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
$name = 'Stream Chat (hidden).lnk'
$lnk = $ws.CreateShortcut((Join-Path $desktop $name))
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$lnk.TargetPath = $electron
$lnk.Arguments = "`"$root`""
$lnk.WorkingDirectory = $root
$lnk.IconLocation = "$electron,0"
$lnk.Description = 'Chat widget invisible to OBS / stream capture'
$lnk.Save()
Write-Output ("Created: " + (Join-Path $desktop $name) + " -> " + $root)
