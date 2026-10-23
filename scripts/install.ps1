param([Parameter(Mandatory=$true)][string]$Windhawk, [switch]$EnableStartup, [switch]$StartNow)
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
if (!(Test-Path -LiteralPath (Join-Path $Windhawk 'windhawk.ini'))) { throw 'This installer expects a portable Windhawk folder.' }
if ($EnableStartup) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (!([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))) {
        throw 'EnableStartup needs one administrator PowerShell run. No files were changed.'
    }
}
if ($StartNow -and !$EnableStartup) { throw 'StartNow requires EnableStartup.' }
$layout = Get-Content -LiteralPath (Join-Path $Windhawk 'windhawk.ini') -Raw
if ($layout -notmatch '(?m)^Portable=1\s*$' -or $layout -notmatch '(?m)^AppDataPath=AppData\s*$') {
    throw 'Only the default portable AppData layout is supported.'
}
# Validate all artifacts before touching an installed mod.
foreach ($name in @('history-limit','phrases')) {
    foreach ($extension in @('dll','wh.cpp')) {
        if (!(Test-Path -LiteralPath (Join-Path $project "dist\$name.$extension"))) { throw 'Run build.ps1 first.' }
    }
}
$backup = Join-Path $Windhawk ('AppData\WinVPlusBackups\' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
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
    $source = Get-Content -LiteralPath (Join-Path $project "dist\$name.wh.cpp") -Raw
    if ($source -notmatch '(?m)^// @version\s+(\S+)') { throw "Missing version: $name" }
    $version = $Matches[1]
    $hash = (Get-FileHash -LiteralPath (Join-Path $project "dist\$name.dll")).Hash.Substring(0,8).ToLowerInvariant()
    $dll = "${id}_${version}_$hash.dll"
    $iniPath = "$mods\$id.ini"
    $oldConfig = if (Test-Path -LiteralPath $iniPath) { Get-Content -LiteralPath $iniPath -Raw } else { '' }
    foreach ($oldFile in @($iniPath,"$sourceFolder\$id.wh.cpp")) {
        if (Test-Path -LiteralPath $oldFile) { Copy-Item -LiteralPath $oldFile -Destination $backup }
    }
    if (!(Test-Path -LiteralPath "$mods\64\$dll")) {
        Copy-Item -LiteralPath (Join-Path $project "dist\$name.dll") -Destination "$mods\64\$dll"
    }
    Copy-Item -LiteralPath (Join-Path $project "dist\$name.wh.cpp") -Destination "$sourceFolder\$id.wh.cpp" -Force
    $process = if ($name -eq 'phrases') { 'TextInputHost.exe' } else { 'svchost.exe' }
    $critical = if ($name -eq 'phrases') { 0 } else { 1 }
    if ($oldConfig) {
        $config = $oldConfig
        foreach ($entry in @{LibraryFileName=$dll;Version=$version}.GetEnumerator()) {
            if ($config -notmatch "(?m)^$($entry.Key)=") { throw "Invalid existing config: $id ($($entry.Key) missing). Backup: $backup" }
            $config = [regex]::Replace($config, "(?m)^$($entry.Key)=[^\r\n]*", "$($entry.Key)=$($entry.Value)")
        }
    } else {
        $config = "[Mod]`r`nLibraryFileName=$dll`r`nDisabled=0`r`nLoggingEnabled=0`r`nInclude=$process`r`nArchitecture=x86-64`r`nVersion=$version`r`nPatternsMatchCriticalSystemProcesses=$critical`r`n"
        if ($name -eq 'history-limit') { $config += "`r`n[Settings]`r`nmaxItems=300`r`nmaxItemSizeMB=32`r`nmaxTotalSizeMB=1024`r`n" }
    }
    [IO.File]::WriteAllText($iniPath, $config, [Text.UnicodeEncoding]::new($false,$true))
}
if ($EnableStartup) { & (Join-Path $PSScriptRoot 'enable-startup.ps1') -Windhawk $Windhawk -StartNow:$StartNow }
Write-Output "Installed both mods. Backup: $backup. Existing limits, enable/disable choices, and phrase files were preserved."
if (!$StartNow) { Write-Output 'Start or restart portable Windhawk to load the changes.' }
