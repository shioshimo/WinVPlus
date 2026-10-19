// ==WindhawkMod==
// @id              winvplus-phrases
// @name            WinVPlus - 常用语
// @description     Add a saved phrases tab to the native Windows 11 clipboard panel.
// @version         0.1.0
// @author          WinVPlus contributors
// @license         MIT
// @include         TextInputHost.exe
// @architecture    x86-64
// @compilerOptions -lole32 -loleaut32 -lruntimeobject
// ==/WindhawkMod==

// WebView discovery and UI-thread dispatch adapted from Win+V Panel Tweaks
// by jayll1303 (MIT). See THIRD_PARTY_NOTICES.md.
#include <windows.h>
#include <windhawk_utils.h>
#include <atomic>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <string>

#undef GetCurrentTime
#include <winrt/Windows.ApplicationModel.DataTransfer.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Security.Cryptography.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/Windows.UI.Xaml.Controls.h>
#include <winrt/Windows.UI.Xaml.Media.h>

namespace wf = winrt::Windows::Foundation;
namespace dt = winrt::Windows::ApplicationModel::DataTransfer;
namespace json = winrt::Windows::Data::Json;
namespace xaml = winrt::Windows::UI::Xaml;
namespace controls = xaml::Controls;
namespace imaging = winrt::Windows::Graphics::Imaging;
namespace streams = winrt::Windows::Storage::Streams;

constexpr wchar_t kPageScript[] = LR"WINVPLUS(/* @ui-script */)WINVPLUS";
std::atomic<bool> g_unloading = false;
std::atomic<bool> g_hooked = false;
std::atomic<DWORD> g_panelThread = 0;
winrt::weak_ref<controls::WebView> g_webView;
winrt::event_token g_navigationToken{}, g_tickToken{};
xaml::DispatcherTimer g_timer{nullptr};
bool g_pollInFlight = false;
unsigned g_idleTicks = 0;
std::mutex g_jobsMutex;
std::condition_variable g_jobsDone;
unsigned g_jobs = 0;

// Only operation counts cross threads. Phrase data stays on the panel UI thread.
struct PendingRequest {
    PendingRequest() { std::lock_guard lock(g_jobsMutex); ++g_jobs; }
    ~PendingRequest() { std::lock_guard lock(g_jobsMutex); --g_jobs; g_jobsDone.notify_all(); }
};

void RunScript(controls::WebView const& view, std::wstring const& script) {
    try { view.InvokeScriptAsync(L"eval", {winrt::hstring(script)}); }
    catch (...) { Wh_Log(L"WebView script failed: %08X", winrt::to_hresult()); }
}

winrt::fire_and_forget RunPageScript(controls::WebView view) {
    if (g_unloading) co_return;
    PendingRequest pending;
    try {
        std::wstring script = L"(function(){try{";
        script += kPageScript;
        script += L";return window.__winvPlus ? (window.__winvPlus.ready?'ready':'waiting') : 'absent';}catch(e){return 'error: '+e.message;}})()";
        auto result = co_await view.InvokeScriptAsync(L"eval", {winrt::hstring(script)});
        Wh_SetStringValue(L"lastScriptResult", result.c_str());
    } catch (winrt::hresult_error const& error) {
        Wh_SetStringValue(L"lastScriptResult", error.message().c_str());
    }
}

void Reply(controls::WebView const& view, json::JsonObject const& reply) {
    if (g_unloading) return;
    std::wstring value = reply.Stringify().c_str();
    // Chakra treats these two characters as JavaScript line separators.
    for (size_t i = 0; i < value.size(); ++i) {
        if (value[i] == 0x2028 || value[i] == 0x2029) {
            value.replace(i, 1, value[i] == 0x2028 ? L"\\u2028" : L"\\u2029");
            i += 5;
        }
    }
    RunScript(view, L"window.__winvPlus && window.__winvPlus.receive(" + value + L");");
}

std::filesystem::path StorePath() {
    wchar_t localAppData[32768];
    DWORD count = GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData, ARRAYSIZE(localAppData));
    if (!count || count >= ARRAYSIZE(localAppData)) throw winrt::hresult_error(E_FAIL, L"找不到常用语数据目录");
    return std::filesystem::path(localAppData) / L"WinVPlus" / L"phrases.json";
}

std::filesystem::path ImagePath(winrt::hstring const& id) {
    GUID guid; winrt::check_hresult(CLSIDFromString(id.c_str(), &guid));
    wchar_t key[40]; StringFromGUID2(guid, key, ARRAYSIZE(key));
    return StorePath().parent_path() / L"images" / (std::wstring(key) + L".png");
}

wf::IAsyncOperation<streams::IBuffer> EncodePng(imaging::SoftwareBitmap bitmap, bool thumbnail) {
    streams::InMemoryRandomAccessStream stream;
    auto encoder = co_await imaging::BitmapEncoder::CreateAsync(imaging::BitmapEncoder::PngEncoderId(), stream);
    encoder.SetSoftwareBitmap(bitmap);
    if (thumbnail) {
        double scale = 256.0 / (std::max)(bitmap.PixelWidth(), bitmap.PixelHeight());
        if (scale < 1) {
            encoder.BitmapTransform().ScaledWidth((std::max)(1u, static_cast<unsigned>(bitmap.PixelWidth() * scale)));
            encoder.BitmapTransform().ScaledHeight((std::max)(1u, static_cast<unsigned>(bitmap.PixelHeight() * scale)));
        }
    }
    co_await encoder.FlushAsync();
    streams::DataReader reader(stream.GetInputStreamAt(0));
    auto size = static_cast<uint32_t>(stream.Size());
    co_await reader.LoadAsync(size);
    co_return reader.ReadBuffer(size);
}

json::JsonArray ReadPhrases() {
    auto path = StorePath();
    if (!std::filesystem::exists(path)) return json::JsonArray();
    std::ifstream stream(path, std::ios::binary);
    if (!stream) throw winrt::hresult_error(E_FAIL, L"常用语文件读取失败");
    std::string data((std::istreambuf_iterator<char>(stream)), {});
    json::JsonArray phrases;
    if (!json::JsonArray::TryParse(winrt::to_hstring(data), phrases))
        throw winrt::hresult_error(E_FAIL, L"常用语文件格式有误，原文件已保留");
    for (auto const& value : phrases) {
        auto phrase = value.GetObject();
        phrase.GetNamedString(L"id");
        if (phrase.GetNamedString(L"type", L"text") == L"image") phrase.GetNamedString(L"preview");
        else phrase.GetNamedString(L"text");
    }
    return phrases;
}

void WritePhrases(json::JsonArray const& phrases) {
    auto path = StorePath();
    std::filesystem::create_directories(path.parent_path());
    auto temp = path; temp += L".tmp";
    std::ofstream stream(temp, std::ios::binary | std::ios::trunc);
    auto text = winrt::to_string(phrases.Stringify());
    stream.write(text.data(), text.size()); stream.close();
    if (!stream || !MoveFileExW(temp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        throw winrt::hresult_error(E_FAIL, L"常用语保存失败，原文件已保留");
}

// A request can await Windows' history API without blocking the panel.
// Unloading waits for these coroutines before detaching the WebView.
winrt::fire_and_forget HandleMessage(controls::WebView view, winrt::hstring message) {
    if (g_unloading) co_return;
    PendingRequest pending;
    json::JsonObject reply;
    try {
        auto request = json::JsonObject::Parse(message);
        auto action = request.GetNamedString(L"action");
        Wh_SetStringValue(L"lastAction", action.c_str());
        Wh_SetIntValue(L"bridgeSeen", 1);
        reply.SetNamedValue(L"action", json::JsonValue::CreateStringValue(action));
        if (action == L"add") {
            auto id = request.GetNamedString(L"id");
            Wh_SetStringValue(L"requestedItemId", id.c_str());
            auto history = co_await dt::Clipboard::GetHistoryItemsAsync();
            if (g_unloading) co_return;
            if (history.Status() != dt::ClipboardHistoryItemsResultStatus::Success)
                throw winrt::hresult_error(E_FAIL, L"暂时读不到历史记录，请重新打开面板");
            dt::ClipboardHistoryItem found{nullptr};
            Wh_SetIntValue(L"publicHistoryCount", history.Items().Size());
            if (history.Items().Size()) Wh_SetStringValue(L"firstPublicItemId", history.Items().GetAt(0).Id().c_str());
            for (auto const& item : history.Items()) if (!_wcsicmp(item.Id().c_str(), id.c_str())) { found = item; break; }
            if (!found) throw winrt::hresult_error(E_FAIL, L"这条记录已被清理");
            bool image = found.Content().Contains(dt::StandardDataFormats::Bitmap());
            winrt::hstring text, preview;
            streams::IBuffer png{nullptr};
            if (image) {
                auto reference = co_await found.Content().GetBitmapAsync();
                auto input = co_await reference.OpenReadAsync();
                auto decoder = co_await imaging::BitmapDecoder::CreateAsync(input);
                auto bitmap = co_await decoder.GetSoftwareBitmapAsync(imaging::BitmapPixelFormat::Bgra8, imaging::BitmapAlphaMode::Premultiplied);
                png = co_await EncodePng(bitmap, false);
                auto thumbnail = co_await EncodePng(bitmap, true);
                preview = L"data:image/png;base64," + winrt::Windows::Security::Cryptography::CryptographicBuffer::EncodeToBase64String(thumbnail);
            } else {
                if (!found.Content().Contains(dt::StandardDataFormats::Text()))
                    throw winrt::hresult_error(E_FAIL, L"这条记录没有文字或图片");
                text = co_await found.Content().GetTextAsync();
                if (text.empty()) throw winrt::hresult_error(E_FAIL, L"这条文字是空的");
            }
            if (g_unloading) co_return;
            // Read after awaiting, so another completed add/remove isn't overwritten.
            auto phrases = ReadPhrases();
            bool duplicate = false;
            for (auto const& value : phrases) {
                auto phrase = value.GetObject();
                if (image ? phrase.GetNamedString(L"sourceId", L"") == id
                          : phrase.GetNamedString(L"type", L"text") == L"text" && phrase.GetNamedString(L"text") == text) {
                    duplicate = true; break;
                }
            }
            if (!duplicate) {
                GUID guid; winrt::check_hresult(CoCreateGuid(&guid));
                wchar_t key[40]; StringFromGUID2(guid, key, ARRAYSIZE(key));
                json::JsonObject phrase;
                phrase.SetNamedValue(L"id", json::JsonValue::CreateStringValue(key));
                if (image) {
                    auto path = ImagePath(key);
                    std::filesystem::create_directories(path.parent_path());
                    std::ofstream output(path, std::ios::binary | std::ios::trunc);
                    output.write(reinterpret_cast<char const*>(png.data()), png.Length()); output.close();
                    if (!output) throw winrt::hresult_error(E_FAIL, L"图片保存失败");
                    phrase.SetNamedValue(L"type", json::JsonValue::CreateStringValue(L"image"));
                    phrase.SetNamedValue(L"sourceId", json::JsonValue::CreateStringValue(id));
                    phrase.SetNamedValue(L"preview", json::JsonValue::CreateStringValue(preview));
                } else phrase.SetNamedValue(L"text", json::JsonValue::CreateStringValue(text));
                phrases.Append(phrase); WritePhrases(phrases);
            }
            reply.SetNamedValue(L"duplicate", json::JsonValue::CreateBooleanValue(duplicate));
            reply.SetNamedValue(L"phrases", phrases);
        } else if (action == L"remove") {
            auto phrases = ReadPhrases();
            auto id = request.GetNamedString(L"id");
            bool image = false;
            for (uint32_t i = 0; i < phrases.Size(); ++i)
                if (phrases.GetObjectAt(i).GetNamedString(L"id") == id) {
                    image = phrases.GetObjectAt(i).GetNamedString(L"type", L"text") == L"image";
                    phrases.RemoveAt(i); break;
                }
            WritePhrases(phrases); reply.SetNamedValue(L"phrases", phrases);
            if (image) std::filesystem::remove(ImagePath(id));
        } else if (action == L"paste") {
            auto id = request.GetNamedString(L"id");
            auto phrases = ReadPhrases();
            bool found = false;
            for (auto const& value : phrases) {
                auto phrase = value.GetObject();
                if (phrase.GetNamedString(L"id") != id) continue;
                dt::DataPackage package;
                if (phrase.GetNamedString(L"type", L"text") == L"image") {
                    std::ifstream input(ImagePath(id), std::ios::binary);
                    if (!input) throw winrt::hresult_error(E_FAIL, L"找不到保存的图片");
                    std::string bytes((std::istreambuf_iterator<char>(input)), {});
                    streams::InMemoryRandomAccessStream stream;
                    streams::DataWriter writer(stream);
                    writer.WriteBytes(winrt::array_view<uint8_t const>(reinterpret_cast<uint8_t const*>(bytes.data()), static_cast<uint32_t>(bytes.size())));
                    co_await writer.StoreAsync(); writer.DetachStream(); stream.Seek(0);
                    if (g_unloading) co_return;
                    package.SetBitmap(streams::RandomAccessStreamReference::CreateFromStream(stream));
                } else package.SetText(phrase.GetNamedString(L"text"));
                dt::Clipboard::SetContent(package);
                found = true; break;
            }
            if (!found) throw winrt::hresult_error(E_FAIL, L"这条常用语已被移除");
        } else if (action == L"load") {
            reply.SetNamedValue(L"phrases", ReadPhrases());
        } else co_return;
        Wh_SetStringValue(L"lastOperationError", L"");
        Wh_SetIntValue(L"lastOperationHresult", 0);
    } catch (winrt::hresult_error const& error) {
        Wh_Log(L"Phrase operation failed: %08X", error.code().value);
        Wh_SetStringValue(L"lastOperationError", error.message().c_str());
        Wh_SetIntValue(L"lastOperationHresult", error.code().value);
        reply.SetNamedValue(L"error", json::JsonValue::CreateStringValue(error.message()));
    } catch (...) {
        Wh_Log(L"Phrase storage failed: %08X", winrt::to_hresult());
        Wh_SetIntValue(L"lastOperationHresult", winrt::to_hresult());
        reply.SetNamedValue(L"error", json::JsonValue::CreateStringValue(L"常用语读写失败，原文件已保留"));
    }
    Reply(view, reply);
}

// Poll the small in-page command queue only while the panel is visible.
// This leaves the system WebView's navigation and permission model untouched.
winrt::fire_and_forget PollMessages(controls::WebView view) {
    if (g_unloading || g_pollInFlight) co_return;
    PendingRequest pending;
    g_pollInFlight = true;
    try {
        auto value = co_await view.InvokeScriptAsync(L"eval", {
            L"JSON.stringify(window.__winvPlus ? window.__winvPlus.drain() : {visible:true,requests:[]})"
        });
        if (!g_unloading) {
            auto batch = json::JsonObject::Parse(value);
            static winrt::hstring lastUiState;
            auto uiState = batch.GetNamedString(L"uiState", L"");
            if (uiState != lastUiState) {
                Wh_SetStringValue(L"lastUiState", uiState.c_str());
                if (batch.GetNamedBoolean(L"visible")) Wh_SetStringValue(L"lastVisibleUiState", uiState.c_str());
                lastUiState = uiState;
            }
            static int lastMenuClicks = -1;
            int clicks = static_cast<int>(batch.GetNamedNumber(L"menuClicks", 0));
            if (clicks != lastMenuClicks) { Wh_SetIntValue(L"menuClicks", clicks); lastMenuClicks = clicks; }
            if (batch.GetNamedBoolean(L"visible")) g_idleTicks = 0;
            else if (++g_idleTicks >= 10) g_timer.Stop();
            auto requests = batch.GetNamedArray(L"requests");
            if (requests.Size()) Wh_SetIntValue(L"queueBridgeSeen", 1);
            for (auto const& request : requests) HandleMessage(view, request.Stringify());
        }
    } catch (winrt::hresult_error const& error) {
        Wh_SetStringValue(L"lastBridgeError", error.message().c_str());
    }
    g_pollInFlight = false;
}

controls::WebView FindWebView(xaml::DependencyObject const& element) {
    if (auto view = element.try_as<controls::WebView>()) return view;
    int count = xaml::Media::VisualTreeHelper::GetChildrenCount(element);
    for (int i = 0; i < count; ++i)
        if (auto view = FindWebView(xaml::Media::VisualTreeHelper::GetChild(element, i))) return view;
    return nullptr;
}

void TrackPanel(void* pageAbi) {
    if (g_unloading) return;
    if (auto view = g_webView.get()) { RunPageScript(view); g_idleTicks = 0; g_timer.Start(); return; }
    wf::IInspectable page; winrt::copy_from_abi(page, pageAbi);
    auto element = page.try_as<xaml::DependencyObject>();
    auto view = element ? FindWebView(element) : nullptr;
    if (!view) return;
    g_navigationToken = view.NavigationCompleted([](controls::WebView const& sender, controls::WebViewNavigationCompletedEventArgs const& args) {
        if (!g_unloading && args.IsSuccess()) { RunPageScript(sender); g_timer.Start(); }
    });
    g_webView = winrt::make_weak(view);
    g_panelThread = GetCurrentThreadId();
    g_timer = xaml::DispatcherTimer();
    g_timer.Interval(std::chrono::milliseconds(100));
    g_tickToken = g_timer.Tick([](auto const&, auto const&) {
        if (!g_unloading) if (auto view = g_webView.get()) PollMessages(view);
    });
    g_timer.Start();
    Wh_SetIntValue(L"panelAttached", 1);
    Wh_Log(L"Native panel WebView attached on thread %u", GetCurrentThreadId());
    RunPageScript(view);
}

using ResetSize = void(WINAPI*)(void*, wf::Size);
ResetSize g_originalResetSize;
void WINAPI ResetSizeHook(void* page, wf::Size size) {
    g_originalResetSize(page, size);
    try { TrackPanel(page); }
    catch (...) { Wh_Log(L"Panel attachment failed: %08X", winrt::to_hresult()); }
}

bool HookInputApp(HMODULE module) {
    if (g_hooked.exchange(true)) return true;
    WindhawkUtils::SYMBOL_HOOK hooks[] = {{
        {L"private: void __cdecl WindowsInternal::ComposableShell::Experiences::TextInputUndocked::InputApp::ExpressiveSuggestionUIPage::ResetControlSize(class Windows::Foundation::Size)"},
        &g_originalResetSize, ResetSizeHook
    }};
    if (!WindhawkUtils::HookSymbols(module, hooks, ARRAYSIZE(hooks))) {
        Wh_Log(L"InputApp symbols unavailable; native panel left unchanged");
        return false;
    }
    Wh_SetIntValue(L"hookReady", 1);
    return true;
}

decltype(&LoadLibraryExW) g_originalLoadLibrary;
HMODULE WINAPI LoadLibraryHook(LPCWSTR path, HANDLE file, DWORD flags) {
    auto module = g_originalLoadLibrary(path, file, flags);
    // Resource-only DLL mappings must never be treated as executable modules.
    if (module && !(flags & (LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE)) && !g_hooked) {
        wchar_t name[MAX_PATH];
        if (GetModuleFileNameW(module, name, ARRAYSIZE(name))) {
            auto basename = wcsrchr(name, L'\\');
            if (basename && !_wcsicmp(basename + 1, L"InputApp.dll") && HookInputApp(module)) Wh_ApplyHookOperations();
        }
    }
    return module;
}

// Execute cleanup on the UI thread which owns the WebView.
void DetachOnPanelThread() {
    if (auto view = g_webView.get()) {
        if (g_timer) { g_timer.Stop(); g_timer.Tick(g_tickToken); g_timer = nullptr; }
        view.NavigationCompleted(g_navigationToken);
        RunScript(view, L"window.__winvPlus && window.__winvPlus.dispose();");
    }
    g_webView = nullptr;
}
void DetachPanel() {
    DWORD threadId = g_panelThread;
    if (!threadId) return;
    if (threadId == GetCurrentThreadId()) { DetachOnPanelThread(); return; }
    HWND window = nullptr;
    while ((window = FindWindowExW(HWND_MESSAGE, window, L"XAMLMessageWindowClass", nullptr)))
        if (GetWindowThreadProcessId(window, nullptr) == threadId) break;
    if (!window) return;
    static UINT message = RegisterWindowMessageW(L"WinVPlus_DetachPanel");
    HHOOK hook = SetWindowsHookExW(WH_CALLWNDPROC, [](int code, WPARAM w, LPARAM l) -> LRESULT {
        if (code == HC_ACTION && reinterpret_cast<CWPSTRUCT*>(l)->message == message) {
            try { DetachOnPanelThread(); } catch (...) { Wh_Log(L"Panel cleanup failed: %08X", winrt::to_hresult()); }
        }
        return CallNextHookEx(nullptr, code, w, l);
    }, nullptr, threadId);
    if (hook) { SendMessageW(window, message, 0, 0); UnhookWindowsHookEx(hook); }
}

BOOL Wh_ModInit() {
    if (auto input = GetModuleHandleW(L"InputApp.dll")) return HookInputApp(input);
    auto load = GetProcAddress(GetModuleHandleW(L"kernelbase.dll"), "LoadLibraryExW");
    WindhawkUtils::SetFunctionHook(reinterpret_cast<decltype(&LoadLibraryExW)>(load), LoadLibraryHook, &g_originalLoadLibrary);
    return TRUE;
}
void Wh_ModAfterInit() {
    if (!g_hooked)
        if (auto module = GetModuleHandleW(L"InputApp.dll")) if (HookInputApp(module)) Wh_ApplyHookOperations();
}
void Wh_ModBeforeUninit() { g_unloading = true; }
void Wh_ModUninit() {
    { std::unique_lock lock(g_jobsMutex); g_jobsDone.wait(lock, [] { return !g_jobs; }); }
    DetachPanel();
}
