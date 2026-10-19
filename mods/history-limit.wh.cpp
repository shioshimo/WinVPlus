// SPDX-License-Identifier: MIT
// Copyright (c) 2026 WinVPlus contributors

// ==WindhawkMod==
// @id              winvplus-history-limit
// @name            WinVPlus Clipboard History Limit
// @description     Adjusts the Windows clipboard history item and memory limits.
// @version         0.1.0
// @author          WinVPlus contributors
// @include         svchost.exe
// @architecture    x86-64
// @compilerOptions -lshell32
// @license          MIT
// ==/WindhawkMod==

// ==WindhawkModReadme==
/*
# WinVPlus Clipboard History Limit

Adjusts the three native limits used by Windows clipboard history (Win+V):
maximum item count, maximum size of one item, and total history buffer size.
The defaults are 300 items, 32 MiB per item, and a 1024 MiB total buffer.
Each limit can be configured independently.

The mod targets Windows 11 25H2 build 26200.6725. It hooks only the three
`ClipboardSettingsImpl` maximum getters in `cbdhsvc.dll`. It runs only in an
`svchost.exe` command line that names `ClipboardSvcGroup`, the older
`UnistackSvcGroup`, or the `cbdhsvc` service with `-s`.
*/
// ==/WindhawkModReadme==

// ==WindhawkModSettings==
/*
- maxItems: 300
  $name: Maximum history items
  $description: Maximum number of entries retained in Win+V. Range 25 to 5000.
- maxItemSizeMB: 32
  $name: Maximum size per item (MB)
  $description: Maximum size of one clipboard history item. Range 1 to 4096 MB.
- maxTotalSizeMB: 1024
  $name: Total history buffer (MB)
  $description: Maximum combined size of clipboard history items. Range 1 to 16384 MB.
*/
// ==/WindhawkModSettings==

#include <windhawk_api.h>
#include <windhawk_utils.h>
#include <windows.h>
#include <shellapi.h>

#include <atomic>

static std::atomic<int> g_maxItems{300};
static std::atomic<int> g_maxItemSizeMB{32};
static std::atomic<int> g_maxTotalSizeMB{1024};

static std::atomic<bool> g_cbdhsvcSymbolsHooked{false};

static int ClampSetting(int value, int minimum, int maximum) {
    if (value < minimum) {
        return minimum;
    }
    if (value > maximum) {
        return maximum;
    }
    return value;
}

static void LoadSettings() {
    g_maxItems.store(ClampSetting(Wh_GetIntSetting(L"maxItems"), 25, 5000),
                     std::memory_order_relaxed);
    g_maxItemSizeMB.store(
        ClampSetting(Wh_GetIntSetting(L"maxItemSizeMB"), 1, 4096),
        std::memory_order_relaxed);
    g_maxTotalSizeMB.store(
        ClampSetting(Wh_GetIntSetting(L"maxTotalSizeMB"), 1, 16384),
        std::memory_order_relaxed);
}

static bool EqualsIgnoreCase(PCWSTR left, PCWSTR right) {
    return left && right &&
           CompareStringOrdinal(left, -1, right, -1, TRUE) == CSTR_EQUAL;
}

static bool IsClipboardServiceHost() {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) {
        return false;
    }

    bool isClipboardServiceHost = false;
    for (int i = 1; i + 1 < argc; ++i) {
        if (EqualsIgnoreCase(argv[i], L"-s") &&
            EqualsIgnoreCase(argv[i + 1], L"cbdhsvc")) {
            isClipboardServiceHost = true;
            break;
        }

        if (EqualsIgnoreCase(argv[i], L"-k") &&
            (EqualsIgnoreCase(argv[i + 1], L"ClipboardSvcGroup") ||
             EqualsIgnoreCase(argv[i + 1], L"UnistackSvcGroup"))) {
            isClipboardServiceHost = true;
            break;
        }
    }

    LocalFree(argv);
    return isClipboardServiceHost;
}

using PFN_GetMaxItemsCount = HRESULT(WINAPI*)(void*, unsigned int*);
static PFN_GetMaxItemsCount g_originalGetMaxItemsCount = nullptr;

static HRESULT WINAPI Hook_GetMaxItemsCount(void* thisPtr,
                                             unsigned int* out) {
    HRESULT hr = g_originalGetMaxItemsCount(thisPtr, out);
    if (SUCCEEDED(hr) && out) {
        *out = static_cast<unsigned int>(
            g_maxItems.load(std::memory_order_relaxed));
    }
    return hr;
}

using PFN_GetMaxSize = HRESULT(WINAPI*)(void*, unsigned __int64*);
static PFN_GetMaxSize g_originalGetMaxItemSize = nullptr;
static PFN_GetMaxSize g_originalGetMaxTotalSize = nullptr;

static HRESULT WINAPI Hook_GetMaxItemSize(void* thisPtr,
                                           unsigned __int64* out) {
    HRESULT hr = g_originalGetMaxItemSize(thisPtr, out);
    if (SUCCEEDED(hr) && out) {
        *out = static_cast<unsigned __int64>(
                   g_maxItemSizeMB.load(std::memory_order_relaxed)) *
               1024ull * 1024ull;
    }
    return hr;
}

static HRESULT WINAPI Hook_GetMaxTotalSize(void* thisPtr,
                                            unsigned __int64* out) {
    HRESULT hr = g_originalGetMaxTotalSize(thisPtr, out);
    if (SUCCEEDED(hr) && out) {
        *out = static_cast<unsigned __int64>(
                   g_maxTotalSizeMB.load(std::memory_order_relaxed)) *
               1024ull * 1024ull;
    }
    return hr;
}

static bool HookCbdhsvcSymbols(HMODULE module) {
    WindhawkUtils::SYMBOL_HOOK hooks[] = {
        {
            { L"public: virtual long __cdecl ClipboardSettingsImpl::get_ClipboardHistoryMaxItemsCount(unsigned int *)" },
            &g_originalGetMaxItemsCount,
            Hook_GetMaxItemsCount,
        },
        {
            { L"public: virtual long __cdecl ClipboardSettingsImpl::get_ClipboardHistoryMaxItemSizeInBytes(unsigned __int64 *)" },
            &g_originalGetMaxItemSize,
            Hook_GetMaxItemSize,
        },
        {
            { L"public: virtual long __cdecl ClipboardSettingsImpl::get_ClipboardHistoryMaxSizeInBytes(unsigned __int64 *)" },
            &g_originalGetMaxTotalSize,
            Hook_GetMaxTotalSize,
        },
    };

    if (!WindhawkUtils::HookSymbols(module, hooks, ARRAYSIZE(hooks))) {
        Wh_Log(L"[WinVPlus] Failed to hook cbdhsvc.dll settings symbols");
        return false;
    }

    return true;
}

static void HookLoadedCbdhsvc(HMODULE module, bool applyOperations) {
    if (GetModuleHandleW(L"cbdhsvc.dll") != module) {
        return;
    }

    bool expected = false;
    if (!g_cbdhsvcSymbolsHooked.compare_exchange_strong(
            expected, true, std::memory_order_acq_rel)) {
        return;
    }

    Wh_Log(L"[WinVPlus] Hooking cbdhsvc.dll settings symbols");
    if (HookCbdhsvcSymbols(module) && applyOperations) {
        Wh_ApplyHookOperations();
    }
}

using LoadLibraryExW_t = decltype(&LoadLibraryExW);
static LoadLibraryExW_t g_originalLoadLibraryExW = nullptr;

static HMODULE WINAPI Hook_LoadLibraryExW(LPCWSTR fileName, HANDLE file,
                                          DWORD flags) {
    HMODULE module = g_originalLoadLibraryExW(fileName, file, flags);
    if (module && !(flags & (LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE))) {
        HookLoadedCbdhsvc(module, true);
    }
    return module;
}

BOOL Wh_ModInit() {
    // This check comes first so unrelated svchost services receive no hooks.
    if (!IsClipboardServiceHost()) {
        return FALSE;
    }

    LoadSettings();

    if (HMODULE module = GetModuleHandleW(L"cbdhsvc.dll")) {
        g_cbdhsvcSymbolsHooked.store(true, std::memory_order_relaxed);
        if (!HookCbdhsvcSymbols(module)) {
            return FALSE;
        }
        return TRUE;
    }

    HMODULE kernelBaseModule = GetModuleHandleW(L"kernelbase.dll");
    auto loadLibraryExW = kernelBaseModule
                              ? reinterpret_cast<LoadLibraryExW_t>(
                                    GetProcAddress(kernelBaseModule,
                                                   "LoadLibraryExW"))
                              : nullptr;
    if (!loadLibraryExW ||
        !WindhawkUtils::SetFunctionHook(loadLibraryExW, Hook_LoadLibraryExW,
                                        &g_originalLoadLibraryExW)) {
        Wh_Log(L"[WinVPlus] Failed to hook LoadLibraryExW");
        return FALSE;
    }

    return TRUE;
}

void Wh_ModAfterInit() {
    if (g_cbdhsvcSymbolsHooked.load(std::memory_order_acquire)) {
        return;
    }

    if (HMODULE module = GetModuleHandleW(L"cbdhsvc.dll")) {
        HookLoadedCbdhsvc(module, true);
    }
}

void Wh_ModSettingsChanged() {
    LoadSettings();
}

void Wh_ModUninit() {
}

/*
MIT License

Copyright (c) 2026 WinVPlus contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/