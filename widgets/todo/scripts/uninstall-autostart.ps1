# Remove o arranque automático e fecha o widget. As tarefas guardadas (%APPDATA%\todo-widget) não são apagadas.
. (Join-Path $PSScriptRoot '..\..\..\scripts\lib\Resolve-Electron.ps1')

$widgetDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskName = 'Todo Widget'

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup')) "$taskName.lnk") -ErrorAction SilentlyContinue

try {
    $electron = Resolve-ElectronPath -WidgetDir $widgetDir
    Get-WidgetMainProcess -ElectronPath $electron -WidgetDir $widgetDir | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}
catch { }

'Arranque automático removido.'
