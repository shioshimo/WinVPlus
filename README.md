# WinVPlus

在 Windows 自带的 Win+V 里多留一点东西。

<img src="docs/preview.png" alt="Windows 原生剪贴板，顶部剪贴板图标右边新增常用语星标" width="420"><img width="287" height="313" alt="{167164F3-C963-4B46-89B6-7C4D2F609ACD}" src="https://github.com/user-attachments/assets/3c5bff98-b299-427a-8a34-1c2a985c6fd0" />

- 历史上限从 25 条改成 300 条。
- 顶部剪贴板右边多一个星标，用来放常用语。
- 右键文字或图片记录 → 添加到常用语。点收藏的条目就粘贴。
- 常用语右键或点省略号，可以移出。

不重做窗口，不加成功提示，不加账号或云端同步。

**目前是实验版。** 针对 Windows 11 x64 开发。确认过的开发环境是 25H2 / 26200.6725；不要把它当成所有 Windows 版本通用的补丁。

当前开发机上已确认原生标签、文字添加和保存，以及图片收藏和粘贴。三项模拟交互测试通过，Windows 自带的 PNG 编解码也已单独验证。300 条历史的完整容量测试、跨重启及其它系统版本仍待验证；目前先公开源码，不发布稳定版安装包。

## 怎么用

需要 [Windhawk](https://windhawk.net/)。目前开发时使用 1.7.3。

如果你已经装了 Windhawk，可以把生成的 `dist/history-limit.wh.cpp` 和 `dist/phrases.wh.cpp` 分别作为本地 mod 编译加载。

源码构建：

```powershell
.\scripts\build.ps1 -Windhawk 'C:\Tools\Windhawk'
```

其中的路径换成你自己的 Windhawk 目录。需要它自带的 Compiler 组件。

便携版 Windhawk 还可以使用安装脚本：

```powershell
.\scripts\install.ps1 -Windhawk 'C:\Tools\Windhawk'
```

这个脚本只支持默认 AppData 布局的便携版，不给标准安装版写注册表。首次加载时启动 Windhawk。扩容涉及系统剪贴板服务，需要以管理员身份运行 Windhawk；新增标签在下次打开 Win+V 时出现。

## 目录

```text
WinVPlus/
├─ mods/
│  ├─ history-limit.wh.cpp  # 三个历史容量 getter
│  └─ phrases.wh.cpp       # 接入原生面板、读取记录、文字和图片的保存与粘贴
├─ ui/
│  └─ phrases.js           # 星标标签、常用语列表和右键菜单
├─ scripts/
│  ├─ build.ps1            # 把 JS 嵌入 C++，生成两份独立 mod 和 DLL
│  └─ install.ps1          # 把编译结果放进便携版 Windhawk
└─ tests/
   └─ phrases.test.cjs     # 导航、右键、长文本、粘贴及卸载的模拟测试
```

运行时就是两份 mod，不需要 Node.js，也不开本地网页服务。Node.js 和 jsdom 只用来测试。

不在 Windows 系统目录里添加或替换文件。收藏存在当前用户的 `%LOCALAPPDATA%\WinVPlus\`：

```text
WinVPlus/
├─ phrases.json           # 文字、图片索引及小预览，普通 UTF-8 JSON
└─ images/
   └─ {id}.png            # 收藏的原图；移出收藏时一并删除
```

## 实现

扩容 mod 在 `cbdhsvc.dll` 上调整三项内部设置：300 条、单条 32 MiB、总缓冲区 1024 MiB。它们分别可调。300 是条数上限；达到总量上限时也会淘汰旧记录。

Windhawk 按 `svchost.exe` 匹配扩容 mod。mod 初始化时会先检查服务组，不属于剪贴板相关服务组就退出，不给其它服务挂容量钩子。

常用语 mod 接入 `TextInputHost.exe` 中原有的 WebView。标签使用页面现有的自定义导航接口。页面把操作放进一个小队列；原生侧在面板打开时每 100 ms 检查一次，收起约一秒后停止。它不使用页面导航来传消息。

添加常用语时，通过公开 Clipboard History API 按记录 ID 读取完整文字或位图。ID 比较忽略大小写，兼容页面与公开接口返回的不同写法。不会拿面板里的 200 字预览当正文。图片用 Windows 自带的编解码器保存为 PNG，列表用最长边 256 像素的小预览，粘贴用原图。保存后，收藏独立于普通历史，清空历史不会清掉它。

常用语列表直接复用当前系统页面的卡片、字体和间距样式类。补充的菜单样式兼容面板使用的旧版 WebView，不依赖 `:focus-visible` 等较新的选择器。

普通历史的重启清理规则仍由 Windows 决定。此版本不添加普通历史的跨重启备份。常用语会保留。

## 体积与兼容性

两个编译后的 mod 合计约 0.6 MiB。这个数字不包含 Windhawk、符号缓存和剪贴板内容。

Windhawk 的完整离线开发环境明显更大。开发机上的 Compiler 约 543 MiB，管理界面约 236 MiB；仓库不携带这些工具，也不把完整工具环境算进“补丁体积”。

容量 getter、`InputApp.dll` 符号及页面内部模型都不是微软保证稳定的扩展接口。Windows 更新可能让其中一处失效。目前没有 Win10、ARM64 或跨所有 servicing build 的兼容保证。

关闭两个 mod 即可停用。整个收藏文件夹独立保存，便于自己迁移。

## 开发测试

```powershell
npm ci
npm test
```

模拟测试不代替真实 Win+V 验收。发布前还需要实际测试：打开面板、右键添加、长文字保存、点击粘贴、关闭重开、清空普通历史后常用语仍在。

代码使用 MIT 许可。接入方式参考的项目见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
