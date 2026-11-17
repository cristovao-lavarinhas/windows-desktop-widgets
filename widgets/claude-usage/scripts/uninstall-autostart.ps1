# Remove o arranque automático, pára o vigilante e fecha o widget.
# A sessão do claude.ai (%APPDATA%\claude-token-widget) só é apagada com "Terminar sessão" no menu do widget.
. (Join-Path $PSScriptRoot '..\..\..\scripts\lib\Resolve-Electron.ps1')

$widgetDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$watcher = Join-Path $PSScriptRoot 'watcher.ps1'

Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Usage Widget.lnk') -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like "*$watcher*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

try {
    $electron = Resolve-ElectronPath -WidgetDir $widgetDir
    Get-WidgetMainProcess -ElectronPath $electron -WidgetDir $widgetDir | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}
catch { }

'Arranque automático removido.'
