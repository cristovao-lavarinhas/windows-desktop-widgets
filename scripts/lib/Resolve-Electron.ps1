# Devolve o caminho do electron.exe usado por um widget (resolve via Node, respeitando os workspaces npm).
function Resolve-ElectronPath {
    param([Parameter(Mandatory)] [string] $WidgetDir)

    Push-Location $WidgetDir
    try {
        $path = (& node -p "require('electron')" 2>$null)
    }
    finally {
        Pop-Location
    }
    if (-not $path -or -not (Test-Path $path)) {
        throw "Electron não encontrado para '$WidgetDir'. Corre 'npm install' na raiz do repositório."
    }
    return (Resolve-Path $path).Path
}

# Processos principais (sem --type=...) do Electron a correr um widget específico.
function Get-WidgetMainProcess {
    param(
        [Parameter(Mandatory)] [string] $ElectronPath,
        [Parameter(Mandatory)] [string] $WidgetDir
    )
    Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object {
        $_.ExecutablePath -eq $ElectronPath -and
        $_.CommandLine -notlike '*--type=*' -and
        $_.CommandLine -like "*$WidgetDir*"
    }
}
