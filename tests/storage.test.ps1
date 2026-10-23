param([Parameter(Mandatory=$true)][string]$Windhawk)
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$work = Join-Path $project ('work\storage-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
$source = Get-Content -LiteralPath (Join-Path $project 'mods\phrases.wh.cpp') -Raw
$pathFunction = $source.Substring($source.IndexOf('std::filesystem::path StorePath()'))
$pathFunction = $pathFunction.Substring(0, $pathFunction.IndexOf('std::filesystem::path ImagePath'))
$storage = $source.Substring($source.IndexOf('// UI-thread cache:'))
$storage = $storage.Substring(0, $storage.IndexOf('// A request can await'))
$header = @'
#include <windows.h>
#include <filesystem>
#include <fstream>
#include <string>
#include <iostream>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h>
namespace json = winrt::Windows::Data::Json;
'@
$main = @'
static void Require(bool ok, char const* message) { if (!ok) throw std::runtime_error(message); }
int wmain(int argc, wchar_t** argv) {
  try {
    Require(argc == 2, "test data path required");
    SetEnvironmentVariableW(L"LOCALAPPDATA", argv[1]);
    winrt::init_apartment();
    Require(ReadPhrases().Size() == 0, "missing file should load empty");
    auto first = json::JsonArray::Parse(L"[{\"id\":\"one\",\"text\":\"original\"}]");
    WritePhrases(first);
    auto revision = StoreRevision();
    auto a = ReadPhrases(); auto b = ReadPhrases();
    Require(winrt::get_abi(a) == winrt::get_abi(b), "unchanged index must reuse cache");
    auto edit = CopyPhrases(a);
    edit.Append(json::JsonObject::Parse(L"{\"id\":\"two\",\"text\":\"next\"}"));
    Require(ReadPhrases().Size() == 1, "pending edit must not mutate cached data");
    WritePhrases(edit);
    Require(ReadPhrases().Size() == 2, "committed edit must refresh cache");
    Require(StoreRevision() != revision, "revision must change after a write");
    { std::ofstream out(StorePath(), std::ios::binary|std::ios::trunc); out << "[{\"id\":\"external\",\"text\":\"updated externally\"}]"; }
    Require(ReadPhrases().GetObjectAt(0).GetNamedString(L"id") == L"external", "external changes must invalidate cache");
    { std::ofstream out(StorePath(), std::ios::binary|std::ios::trunc); out << "broken json"; }
    bool rejected = false;
    try { ReadPhrases(); } catch (...) { rejected = true; }
    Require(rejected, "corrupt file must be rejected instead of hidden by cache");
    { std::ifstream in(StorePath(), std::ios::binary); std::string data((std::istreambuf_iterator<char>(in)), {}); Require(data == "broken json", "failed read must preserve original file"); }
    std::cout << "PASS: real WinRT storage cache, copy-on-write, revision, external reload, corrupt-file preservation\n";
    return 0;
  } catch (winrt::hresult_error const& e) { std::cerr << winrt::to_string(e.message()) << "\n"; return 1; }
    catch (std::exception const& e) { std::cerr << e.what() << "\n"; return 1; }
}
'@
$cpp = Join-Path $work 'storage.cpp'
$exe = Join-Path $work 'storage.exe'
[IO.File]::WriteAllText($cpp, ($header + "`n" + $pathFunction + $storage + $main), [Text.UTF8Encoding]::new($false))
$compiler = Join-Path $Windhawk 'Compiler\bin\clang++.exe'
Push-Location (Join-Path $Windhawk 'Compiler')
try {
    & $compiler -std=c++23 -O2 -DUNICODE -D_UNICODE -target x86_64-w64-mingw32 -municode $cpp -o $exe -lole32 -loleaut32 -lruntimeobject
    if ($LASTEXITCODE) { throw 'Storage test compilation failed.' }
} finally { Pop-Location }
$previousPath = $env:PATH
try {
    # Windhawk's compiler links against its renamed runtime libraries.
    foreach ($runtime in @('libc++','libunwind')) {
        Copy-Item -LiteralPath (Join-Path $Windhawk "Compiler\x86_64-w64-mingw32\bin\$runtime.dll") -Destination (Join-Path $work "$runtime.whl")
    }
    $env:PATH = (Join-Path $Windhawk 'Compiler\x86_64-w64-mingw32\bin') + ';' + $previousPath
    & $exe (Join-Path $work 'isolated-data')
    if ($LASTEXITCODE) { throw "Storage regression test failed: $LASTEXITCODE" }
} finally { $env:PATH = $previousPath }
