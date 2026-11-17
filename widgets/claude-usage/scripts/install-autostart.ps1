# Instala o vigilante do widget de uso do Claude na pasta Arranque (Startup) do utilizador (não requer administrador).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\..\scripts\lib\Resolve-Electron.ps1')

$widgetDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electron = Resolve-ElectronPath -WidgetDir $widgetDir
$watcher = Join-Path $PSScriptRoot 'watcher.ps1'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Usage Widget.lnk'

# conhost --headless evita a janela de consola do PowerShell.
$arguments = "--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden " +
    "-File `"$watcher`" -ElectronPath `"$electron`" -WidgetDir `"$widgetDir`""

$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$env:WINDIR\System32\conhost.exe"
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $widgetDir
$shortcut.Description = 'Abre o widget de uso do Claude quando o Claude Desktop arranca'
$shortcut.Save()

# Reinicia o vigilante para usar a versão atual.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like "*$watcher*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Process -FilePath "$env:WINDIR\System32\conhost.exe" -ArgumentList $arguments -WorkingDirectory $widgetDir

"OK: atalho criado em $shortcutPath"
