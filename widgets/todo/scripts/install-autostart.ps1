# Arranque automático do widget de tarefas no login do Windows (não requer administrador).
# Regista uma tarefa agendada que relança o widget se este terminar com erro;
# se o registo falhar, recorre a um atalho na pasta Arranque (Startup).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\..\scripts\lib\Resolve-Electron.ps1')

$widgetDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electron = Resolve-ElectronPath -WidgetDir $widgetDir
$taskName = 'Todo Widget'
$user = "$env:USERDOMAIN\$env:USERNAME"
$startupShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) "$taskName.lnk"

try {
    $action = New-ScheduledTaskAction -Execute $electron -Argument "`"$widgetDir`"" -WorkingDirectory $widgetDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $trigger.Delay = 'PT10S'   # dá tempo ao Explorer para criar o ambiente de trabalho
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew -Priority 6
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
        -Principal $principal -Description 'Widget de tarefas diárias no ambiente de trabalho' -Force | Out-Null
    Remove-Item $startupShortcut -ErrorAction SilentlyContinue
    "OK: tarefa agendada '$taskName' registada."
}
catch {
    "Tarefa agendada indisponível ($($_.Exception.Message)); a usar um atalho na pasta Arranque."
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($startupShortcut)
    $shortcut.TargetPath = $electron
    $shortcut.Arguments = "`"$widgetDir`""
    $shortcut.WorkingDirectory = $widgetDir
    $shortcut.Save()
    'OK: atalho criado.'
}

if (-not (Get-WidgetMainProcess -ElectronPath $electron -WidgetDir $widgetDir)) {
    Start-Process -FilePath $electron -ArgumentList "`"$widgetDir`"" -WorkingDirectory $widgetDir
    'Widget iniciado.'
}
