param([Parameter(Mandatory=$true)][string]$Windhawk)
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$compiler = Join-Path $Windhawk 'Compiler\bin\clang++.exe'
$library = Join-Path $Windhawk 'Engine\64\windhawk.lib'
if (!(Test-Path -LiteralPath $compiler) -or !(Test-Path -LiteralPath $library)) {
    throw "Windhawk compiler not found in $Windhawk"
}
$dist = Join-Path $project 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$ui = Get-Content (Join-Path $project 'ui\phrases.js') -Raw
foreach ($name in @('history-limit', 'phrases')) {
    $source = Get-Content (Join-Path $project "mods\$name.wh.cpp") -Raw
    $source = $source.Replace('/* @ui-script */', $ui)
    $outputSource = Join-Path $dist "$name.wh.cpp"
    [IO.File]::WriteAllText($outputSource, $source, [Text.UTF8Encoding]::new($false))
    $id = if ($name -eq 'phrases') { 'winvplus-phrases' } else { 'winvplus-history-limit' }
    $flags = @('-std=c++23','-O2','-shared','-DUNICODE','-D_UNICODE',
        '-DWINVER=0x0A00','-D_WIN32_WINNT=0x0A00','-D_WIN32_IE=0x0A00',
        '-DNTDDI_VERSION=0x0A000008','-D__USE_MINGW_ANSI_STDIO=0','-DWH_MOD',
        "-DWH_MOD_ID=L`"$id`"",'-DWH_MOD_VERSION=L"0.1.0"',
        $library, $outputSource, '-include','windhawk_api.h',
        '-target','x86_64-w64-mingw32','-Wl,--export-all-symbols',
        '-o',(Join-Path $dist "$name.dll"),'-lole32','-loleaut32','-lruntimeobject')
    Push-Location (Join-Path $Windhawk 'Compiler')
    try { & $compiler @flags; if ($LASTEXITCODE) { throw "Compilation failed: $name" } }
    finally { Pop-Location }
    Write-Output "Built $name"
}
