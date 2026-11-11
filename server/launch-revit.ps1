param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$resolved = (Resolve-Path -LiteralPath $Executable).Path
if ([IO.Path]::GetFileName($resolved) -ne 'Revit.exe') { throw 'Expected Revit.exe' }
$before = @(Get-Process Revit -ErrorAction SilentlyContinue | ForEach-Object Id)
# The desktop shell launches Revit in the interactive user context. A direct child
# of a service/logon helper can have a different licensing context despite the same username.
$shellFactory = New-Object -ComObject Shell.Application
$desktopHandle = 0
# SWC_DESKTOP=8, SWFO_NEEDDISPATCH=1. Obtain the existing Explorer object's
# Application interface; a fresh Shell.Application object alone uses the caller's context.
$desktopView = $shellFactory.Windows().FindWindowSW(0, 0, 8, [ref]$desktopHandle, 1)
if ($null -eq $desktopView) { throw 'Interactive desktop is unavailable; launch Revit manually' }
$desktopView.Document.Application.ShellExecute($resolved, '', [IO.Path]::GetDirectoryName($resolved), 'open', 1)
Start-Sleep -Seconds 2
$candidates = @(Get-Process Revit -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $before -and $_.Path -eq $resolved } | ForEach-Object Id)
@{ candidatePids = $candidates } | ConvertTo-Json -Compress
