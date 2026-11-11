param(
    [ValidateSet('2025','2026')][string[]]$Years,
    [string]$WorkspaceRoot = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'RevitBridge\Models'),
    [string]$AutodeskRoot = (Join-Path $env:ProgramFiles 'Autodesk'),
    [string]$SkillsPath,
    [ValidateSet('ru','en')][string]$Language = 'ru',
    [switch]$CheckOnly,
    [switch]$Remove,
    [switch]$SkipDependencies
)
$ErrorActionPreference = 'Stop'
$server = Join-Path $PSScriptRoot 'server'
$addinId = '1DF07C11-7AC4-4329-ACFA-22A30144EBB7'
$configPath = Join-Path $server 'config.json'
$previousConfig = $null
if (Test-Path -LiteralPath $configPath) {
    $previousConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if (!$PSBoundParameters.ContainsKey('WorkspaceRoot')) { $WorkspaceRoot = $previousConfig.workspaceRoot }
    if (!$PSBoundParameters.ContainsKey('AutodeskRoot')) { $AutodeskRoot = $previousConfig.autodeskRoot }
}
if (!$Years) {
    $Years = @('2025','2026') | Where-Object { Test-Path -LiteralPath (Join-Path $AutodeskRoot "Revit $_\Revit.exe") }
}
if (!$Years) { throw 'No supported Revit installation found / Поддерживаемый Revit не найден.' }
if ($Remove) {
    foreach ($year in $Years) {
        $manifest = Join-Path $env:APPDATA "Autodesk\Revit\Addins\$year\RevitBridge.addin"
        if (Test-Path -LiteralPath $manifest) {
            [xml]$existing = Get-Content -LiteralPath $manifest -Raw
            if ($existing.RevitAddIns.AddIn.AddInId -ne $addinId) { throw "Unrelated manifest: $manifest" }
            if (!$CheckOnly) { Remove-Item -LiteralPath $manifest }
        }
    }
    if ($CheckOnly) { Write-Output 'Check only: owned registration would be removed / Проверка без удаления регистрации.' }
    else { Write-Output 'Registration removed / Регистрация удалена. Restart Revit / Перезапустите Revit.' }
    return
}
$missingBuilds = @($Years | Where-Object { !(Test-Path -LiteralPath (Join-Path $server "bin\$_\RevitWorkspaceBridge.dll")) })
$node = Get-Command node -ErrorAction SilentlyContinue
$sdk = Get-Command dotnet -ErrorAction SilentlyContinue
if ($CheckOnly) {
    [pscustomobject]@{ Years=$Years; NodeAvailable=[bool]$node; DotnetCommandAvailable=[bool]$sdk; BuildsMissing=$missingBuilds; WorkspaceRoot=[IO.Path]::GetFullPath($WorkspaceRoot); SkillsPath=$SkillsPath } | ConvertTo-Json
    return
}
if ($SkillsPath) {
    foreach ($skill in Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'skills') -Directory) {
        $target = Join-Path $SkillsPath $skill.Name
        if (Test-Path -LiteralPath $target) { throw "Skill already exists; review before replacing: $target" }
    }
}
if (!$node) { throw 'Install Node.js 22 or newer: https://nodejs.org/en/download' }
$nodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw 'Node.js 22 or newer is required.' }
if ($missingBuilds.Count) {
    if (!$sdk) { throw 'Missing bridge build. Build from source with the .NET 8 SDK: https://dotnet.microsoft.com/download/dotnet/8.0' }
    & (Join-Path $PSScriptRoot 'build.ps1') -Years $missingBuilds -AutodeskRoot $AutodeskRoot
}
if (!$SkipDependencies) {
    & npm.cmd ci --prefix $server --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed / Не удалось установить зависимости.' }
}
$workspace = [IO.Path]::GetFullPath($WorkspaceRoot)
$stateRoot = if ($previousConfig -and $previousConfig.stateRoot) { $previousConfig.stateRoot } else { Join-Path $env:LOCALAPPDATA 'RevitBridge\state' }
New-Item -ItemType Directory -Path $workspace,$stateRoot -Force | Out-Null
if (Test-Path -LiteralPath $configPath) { Copy-Item -LiteralPath $configPath -Destination ($configPath + '.bak') }
@{ workspaceRoot=$workspace; stateRoot=$stateRoot; autodeskRoot=$AutodeskRoot; supportedVersions=@($Years) } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
foreach ($year in $Years) {
    $directory = Join-Path $env:APPDATA "Autodesk\Revit\Addins\$year"
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $manifest = Join-Path $directory 'RevitBridge.addin'
    if (Test-Path -LiteralPath $manifest) {
        [xml]$existing = Get-Content -LiteralPath $manifest -Raw
        if ($existing.RevitAddIns.AddIn.AddInId -ne $addinId) { throw "Unrelated manifest: $manifest" }
        Copy-Item -LiteralPath $manifest -Destination ($manifest + '.bak')
    }
    $dll = [Security.SecurityElement]::Escape((Join-Path $server "bin\$year\RevitWorkspaceBridge.dll"))
    $xml = @"
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns><AddIn Type="Application"><Name>Revit Bridge</Name><Assembly>$dll</Assembly><AddInId>$addinId</AddInId><FullClassName>RevitWorkspace.Bridge</FullClassName><VendorId>RVBR</VendorId><VendorDescription>Revit Bridge MCP</VendorDescription></AddIn></RevitAddIns>
"@
    Set-Content -LiteralPath $manifest -Value $xml -Encoding utf8
}
if ($SkillsPath) {
    New-Item -ItemType Directory -Path $SkillsPath -Force | Out-Null
    foreach ($skill in Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'skills') -Directory) {
        $target = Join-Path $SkillsPath $skill.Name
        if (Test-Path -LiteralPath $target) { throw "Skill already exists; review before replacing: $target" }
        Copy-Item -LiteralPath $skill.FullName -Destination $target -Recurse
    }
}
$snippet = @{mcpServers=@{'revit-bridge'=@{command=$node.Source;args=@((Join-Path $server 'server.mjs'))}}}
$snippet | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $server 'mcp-client.local.json') -Encoding utf8
if ($Language -eq 'ru') { Write-Output 'Установлено. Перезапустите Revit. Добавьте сервер в MCP-клиент по server/mcp-client.local.json. Проверка: node server/doctor.mjs' }
else { Write-Output 'Installed. Restart Revit. Register the MCP server using server/mcp-client.local.json. Check: node server/doctor.mjs' }
