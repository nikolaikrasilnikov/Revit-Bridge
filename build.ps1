param(
    [ValidateSet('2025','2026')][string[]]$Years = @('2025','2026'),
    [string]$DotNet = 'dotnet',
    [string]$AutodeskRoot = (Join-Path $env:ProgramFiles 'Autodesk')
)
$ErrorActionPreference = 'Stop'
foreach ($year in $Years) {
    $revitRoot = Join-Path $AutodeskRoot "Revit $year"
    if (!(Test-Path -LiteralPath (Join-Path $revitRoot 'RevitAPI.dll'))) { throw "Revit $year API is missing: $revitRoot" }
    $destination = Join-Path $PSScriptRoot "server\bin\$year"
    & $DotNet build (Join-Path $PSScriptRoot 'bridge\RevitWorkspaceBridge.csproj') -c Release "-p:RevitYear=$year" "-p:RevitRoot=$revitRoot" "-p:PathMap=$PSScriptRoot=/_/" '-p:DebugType=None' '-p:RestoreIgnoreFailedSources=true' -o $destination --nologo
    if ($LASTEXITCODE -ne 0) { throw "Build failed for Revit $year" }
}
