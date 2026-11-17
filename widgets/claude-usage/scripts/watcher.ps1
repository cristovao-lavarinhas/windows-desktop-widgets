# Vigilante do widget de uso do Claude (arranca no login, sem consola visível):
# abre o widget quando o Claude Desktop arranca e, opcionalmente, fecha-o quando o Claude fecha.
param(
    [Parameter(Mandatory)] [string] $ElectronPath,
    [Parameter(Mandatory)] [string] $WidgetDir
)

$ErrorActionPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot '..\..\..\scripts\lib\Resolve-Electron.ps1')
$pollSeconds = 4

# Uma só instância do vigilante por sessão.
$mutex = New-Object System.Threading.Mutex($false, 'Local\ClaudeUsageWidgetWatcher')
if (-not $mutex.WaitOne(0)) { exit }

function Get-Config {
    try { Get-Content (Join-Path $WidgetDir 'config.json') -Raw | ConvertFrom-Json } catch { [pscustomobject]@{} }
}

# O Claude Code (CLI) também se chama claude.exe, por isso filtramos pelo caminho da app desktop.
function Test-ClaudeDesktopRunning {
    [bool](Get-Process -Name claude | Where-Object {
        $_.Path -like '*\WindowsApps\Claude_*' -or $_.Path -like '*\AnthropicClaude\*'
    } | Select-Object -First 1)
}

function Get-WidgetProcess {
    Get-WidgetMainProcess -ElectronPath $ElectronPath -WidgetDir $WidgetDir
}

Start-Sleep -Seconds 5   # dá tempo ao Explorer para criar o ambiente de trabalho
$claudeWasRunning = $false

while ($true) {
    $claudeRunning = Test-ClaudeDesktopRunning

    if ($claudeRunning -and -not $claudeWasRunning) {
        # Só no momento em que o Claude abre: se o widget for fechado à mão, não volta a abrir sozinho.
        if (-not (Get-WidgetProcess)) {
            Start-Process -FilePath $ElectronPath -ArgumentList "`"$WidgetDir`"" -WorkingDirectory $WidgetDir
        }
    }
    elseif (-not $claudeRunning -and $claudeWasRunning) {
        if ((Get-Config).closeWithClaude -ne $false) {
            # Terminar o processo principal fecha também os processos filhos do Electron.
            Get-WidgetProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
        }
    }

    $claudeWasRunning = $claudeRunning
    Start-Sleep -Seconds $pollSeconds
}
