param([Parameter(Mandatory=$true)][string]$Windhawk)
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
if (!(Test-Path -LiteralPath (Join-Path $Windhawk 'windhawk.ini'))) { throw 'This installer expects a portable Windhawk folder.' }
$mods = Join-Path $Windhawk 'AppData\Engine\Mods'
$sourceFolder = Join-Path $Windhawk 'AppData\ModsSource'
New-Item -ItemType Directory -Path "$mods\64",$sourceFolder -Force | Out-Null
foreach ($runtime in @('libc++','libunwind')) {
    $target = "$mods\64\$runtime.whl"
    if (!(Test-Path -LiteralPath $target)) {
        Copy-Item -LiteralPath (Join-Path $Windhawk "Compiler\x86_64-w64-mingw32\bin\$runtime.dll") -Destination $target
    }
}
foreach ($name in @('history-limit','phrases')) {
    $id = if ($name -eq 'phrases') { 'winvplus-phrases' } else { 'winvplus-history-limit' }
    if (!(Test-Path -LiteralPath (Join-Path $project "dist\$name.dll"))) { throw 'Run build.ps1 first.' }
    $hash = (Get-FileHash -LiteralPath (Join-Path $project "dist\$name.dll")).Hash.Substring(0,8).ToLowerInvariant()
    $dll = "${id}_0.1.0_$hash.dll"
    if (!(Test-Path -LiteralPath "$mods\64\$dll")) {
        Copy-Item -LiteralPath (Join-Path $project "dist\$name.dll") -Destination "$mods\64\$dll"
    }
    Copy-Item -LiteralPath (Join-Path $project "dist\$name.wh.cpp") -Destination "$sourceFolder\$id.wh.cpp" -Force
    $process = if ($name -eq 'phrases') { 'TextInputHost.exe' } else { 'svchost.exe' }
    $critical = if ($name -eq 'phrases') { 0 } else { 1 }
    $config = "[Mod]`r`nLibraryFileName=$dll`r`nDisabled=0`r`nLoggingEnabled=1`r`nInclude=$process`r`nArchitecture=x86-64`r`nVersion=0.1.0`r`nPatternsMatchCriticalSystemProcesses=$critical`r`n"
    if ($name -eq 'history-limit') { $config += "`r`n[Settings]`r`nmaxItems=300`r`nmaxItemSizeMB=32`r`nmaxTotalSizeMB=1024`r`n" }
    [IO.File]::WriteAllText("$mods\$id.ini", $config, [Text.UnicodeEncoding]::new($false,$true))
}
Write-Output 'Installed both mods. Start or restart portable Windhawk to load them.'
