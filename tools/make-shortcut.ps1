$desktop = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
$name = 'Stream Chat (hidden).lnk'
$lnk = $ws.CreateShortcut((Join-Path $desktop $name))
$lnk.TargetPath = 'F:\z.ai\Custom\obs-hidden-chat\node_modules\electron\dist\electron.exe'
$lnk.Arguments = 'F:\z.ai\Custom\obs-hidden-chat'
$lnk.WorkingDirectory = 'F:\z.ai\Custom\obs-hidden-chat'
$lnk.IconLocation = 'F:\z.ai\Custom\obs-hidden-chat\node_modules\electron\dist\electron.exe,0'
$lnk.Description = 'Chat widget invisible to OBS / stream capture'
$lnk.Save()
Write-Output ("created: " + (Join-Path $desktop $name))
